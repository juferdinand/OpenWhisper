use std::time::Duration;

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
const REMOTE_DESKTOP: &str = "org.freedesktop.portal.RemoteDesktop";
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(1);
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub shortcut_version: Option<u32>,
    pub remote_desktop_version: Option<u32>,
    pub keyboard: bool,
}

async fn interface_capability(
    connection: &zbus::Connection,
    destination: &str,
    interface: &str,
    keyboard: bool,
    timeout: Duration,
) -> Option<(u32, bool)> {
    tokio::time::timeout(timeout, async {
        // Ashpd defaults to version 1 after some property failures. Read the actual
        // interface instead; constructing a proxy does not prove a portal exists.
        let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
            .destination(destination)?
            .path(PATH)?
            .interface(interface)?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await?;
        let version = proxy.get_property::<u32>("version").await?;
        if version == 0 {
            return Ok::<_, zbus::Error>(None);
        }
        let keyboard = if keyboard {
            // XDG RemoteDesktop device types: KEYBOARD=1, POINTER=2, TOUCHSCREEN=4.
            proxy.get_property::<u32>("AvailableDeviceTypes").await? & 1 != 0
        } else {
            false
        };
        Ok(Some((version, keyboard)))
    })
    .await
    .ok()?
    .ok()?
}

async fn with_connection(
    connection: &zbus::Connection,
    destination: &str,
    timeout: Duration,
) -> Capabilities {
    // A stalled interface must not hide a different working portal.
    let (shortcut, remote) = tokio::join!(
        interface_capability(connection, destination, SHORTCUTS, false, timeout),
        interface_capability(connection, destination, REMOTE_DESKTOP, true, timeout),
    );
    Capabilities {
        shortcut_version: shortcut.map(|(version, _)| version),
        remote_desktop_version: remote.map(|(version, _)| version),
        keyboard: remote.is_some_and(|(_, keyboard)| keyboard),
    }
}

pub async fn probe() -> Capabilities {
    match tokio::time::timeout(CONNECTION_TIMEOUT, zbus::Connection::session()).await {
        Ok(Ok(connection)) => with_connection(&connection, DESTINATION, QUERY_TIMEOUT).await,
        _ => Capabilities::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Child};

    struct OwnedBus {
        process: Child,
        directory: PathBuf,
        address: String,
    }

    impl OwnedBus {
        async fn start() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("openwhisper-portal-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
            let address = format!("unix:path={}", directory.join("bus").display());
            let config = directory.join("bus.conf");
            fs::write(
                &config,
                format!(
                "<busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth>\
                 <policy context=\"default\"><allow own=\"*\"/><allow send_destination=\"*\"/>\
                 <allow receive_sender=\"*\"/></policy></busconfig>"
            ),
            )
            .unwrap();
            let process = std::process::Command::new("/usr/bin/dbus-daemon")
                .env_clear()
                .args(["--nofork", "--config-file"])
                .arg(config)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("dbus-daemon is required for owned portal tests");
            let mut bus = Self {
                process,
                directory,
                address,
            };
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            while !bus.directory.join("bus").exists() {
                assert!(
                    bus.process.try_wait().unwrap().is_none(),
                    "Owned bus exited"
                );
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Owned bus startup timed out"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bus
        }

        async fn connection(&self) -> zbus::Connection {
            tokio::time::timeout(
                Duration::from_secs(2),
                zbus::connection::Builder::address(self.address.as_str())
                    .unwrap()
                    .build(),
            )
            .await
            .expect("Owned bus connection timed out")
            .unwrap()
        }

        async fn service(&self) -> zbus::Connection {
            // serve_at makes Builder wait for the method dispatcher to subscribe.
            // Adding the first interface after build can race and lose its first call.
            tokio::time::timeout(
                Duration::from_secs(2),
                zbus::connection::Builder::address(self.address.as_str())
                    .unwrap()
                    .serve_at("/org/openwhisper/OwnedFixture", Ready)
                    .unwrap()
                    .build(),
            )
            .await
            .expect("Owned service startup timed out")
            .unwrap()
        }
    }

    struct Ready;
    #[zbus::interface(name = "org.openwhisper.OwnedPortalFixture")]
    impl Ready {
        fn ping(&self) {}
    }

    impl Drop for OwnedBus {
        fn drop(&mut self) {
            let _ = self.process.kill();
            let _ = self.process.wait();
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    struct Shortcuts {
        version: u32,
        delay: Duration,
    }
    #[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
    impl Shortcuts {
        #[zbus(property, name = "version")]
        async fn version(&self) -> u32 {
            tokio::time::sleep(self.delay).await;
            self.version
        }
    }

    struct WrongVersion;
    #[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
    impl WrongVersion {
        #[zbus(property, name = "version")]
        fn version(&self) -> &str {
            "1"
        }
    }

    struct RemoteDesktop {
        devices: Option<u32>,
    }
    #[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
    impl RemoteDesktop {
        #[zbus(property, name = "version")]
        fn version(&self) -> u32 {
            2
        }
        #[zbus(property)]
        fn available_device_types(&self) -> zbus::fdo::Result<u32> {
            self.devices
                .ok_or_else(|| zbus::fdo::Error::UnknownProperty("Missing device types".into()))
        }
    }

    #[tokio::test]
    async fn owned_bus_requires_answering_interfaces_and_keyboard_support() {
        let bus = OwnedBus::start().await;
        let client = bus.connection().await;
        let timeout = Duration::from_millis(250);
        assert_eq!(
            with_connection(&client, DESTINATION, timeout).await,
            Capabilities::default()
        );
        let service = bus.service().await;
        let destination = service.unique_name().unwrap().as_str();
        assert_eq!(
            with_connection(&client, destination, timeout).await,
            Capabilities::default()
        );
        service
            .object_server()
            .at(PATH, WrongVersion)
            .await
            .unwrap();
        assert_eq!(
            with_connection(&client, destination, timeout).await,
            Capabilities::default()
        );
        service
            .object_server()
            .remove::<WrongVersion, _>(PATH)
            .await
            .unwrap();
        service
            .object_server()
            .at(
                PATH,
                Shortcuts {
                    version: 0,
                    delay: Duration::ZERO,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            with_connection(&client, destination, timeout).await,
            Capabilities::default()
        );
        service
            .object_server()
            .remove::<Shortcuts, _>(PATH)
            .await
            .unwrap();
        for version in [1, 2] {
            service
                .object_server()
                .at(
                    PATH,
                    Shortcuts {
                        version,
                        delay: Duration::ZERO,
                    },
                )
                .await
                .unwrap();
            let capabilities = with_connection(&client, destination, timeout).await;
            assert_eq!(capabilities.shortcut_version, Some(version));
            assert!(!capabilities.keyboard);
            service
                .object_server()
                .remove::<Shortcuts, _>(PATH)
                .await
                .unwrap();
        }
        for (devices, expected_version, keyboard) in [
            (None, None, false),
            (Some(2), Some(2), false),
            (Some(3), Some(2), true),
        ] {
            service
                .object_server()
                .at(PATH, RemoteDesktop { devices })
                .await
                .unwrap();
            let capabilities = with_connection(&client, destination, timeout).await;
            assert_eq!(capabilities.remote_desktop_version, expected_version);
            assert_eq!(capabilities.keyboard, keyboard);
            service
                .object_server()
                .remove::<RemoteDesktop, _>(PATH)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn owned_bus_bounds_stalled_properties_without_hiding_working_interface() {
        let bus = OwnedBus::start().await;
        let client = bus.connection().await;
        let service = bus.service().await;
        service
            .object_server()
            .at(
                PATH,
                Shortcuts {
                    version: 1,
                    delay: Duration::from_secs(1),
                },
            )
            .await
            .unwrap();
        service
            .object_server()
            .at(PATH, RemoteDesktop { devices: Some(1) })
            .await
            .unwrap();
        assert_eq!(
            interface_capability(
                &client,
                service.unique_name().unwrap().as_str(),
                REMOTE_DESKTOP,
                true,
                Duration::from_millis(250)
            )
            .await,
            Some((2, true)),
            "Owned working interface must answer before the stalled query"
        );
        let started = tokio::time::Instant::now();
        let capabilities = with_connection(
            &client,
            service.unique_name().unwrap().as_str(),
            Duration::from_millis(100),
        )
        .await;
        assert_eq!(
            capabilities,
            Capabilities {
                shortcut_version: None,
                remote_desktop_version: Some(2),
                keyboard: true
            }
        );
        assert!(
            started.elapsed() < Duration::from_millis(750),
            "Property read exceeded its deadline"
        );
    }
}
