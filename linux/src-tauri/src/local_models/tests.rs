use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
};

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../shared/local-processing-vectors.json"
    ))
    .unwrap()
}
fn enabled() -> Profile {
    Profile {
        enabled: true,
        model: "owned-fixture".into(),
        ..Profile::default()
    }
}

#[test]
fn shared_endpoint_and_output_contracts_match() {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../shared/local-processing.schema.json"
    ))
    .unwrap();
    let defaults = serde_json::to_value(Profile::default()).unwrap();
    for (key, default) in defaults.as_object().unwrap() {
        assert_eq!(&schema["properties"][key]["default"], default);
        assert!(schema["required"].as_array().unwrap().contains(&json!(key)));
    }
    let cases = vectors();
    for case in cases["valid_endpoints"].as_array().unwrap() {
        let p = Profile {
            provider: case["provider"].as_str().unwrap().into(),
            endpoint: case["endpoint"].as_str().unwrap().into(),
            ..enabled()
        };
        assert_eq!(
            p.request_url().unwrap().as_str(),
            case["request_url"].as_str().unwrap()
        );
    }
    for endpoint in cases["invalid_endpoints"].as_array().unwrap() {
        assert!(
            Profile {
                endpoint: endpoint.as_str().unwrap().into(),
                ..enabled()
            }
            .validate()
            .is_err(),
            "{endpoint}"
        );
    }
    for case in cases["responses"].as_array().unwrap() {
        let p = Profile {
            provider: case["provider"].as_str().unwrap().into(),
            ..enabled()
        };
        match case["expected"].as_str() {
            Some(text) => assert_eq!(p.output(&case["value"]).unwrap(), text),
            None => assert!(p.output(&case["value"]).is_err()),
        }
    }
    for profile in cases["invalid_profiles"].as_array().unwrap() {
        let result = serde_json::from_value::<Profile>(profile.clone());
        assert!(result.is_err() || result.unwrap().validate().is_err());
    }
    for profile in cases["valid_profile_patches"].as_array().unwrap() {
        serde_json::from_value::<Profile>(profile.clone())
            .unwrap()
            .validate()
            .unwrap();
    }
    let p = enabled();
    assert!(p.output(&json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"x".repeat(MAX_TEXT_BYTES+1)}}]})).is_err());
}

/// Each fixture owns one random-port loopback server and receives only synthetic text.
fn fixture(
    status: &str,
    body: Vec<u8>,
    delay: Duration,
) -> (
    String,
    mpsc::Receiver<(String, Value)>,
    thread::JoinHandle<()>,
) {
    streamed_fixture(status, body, delay, Duration::ZERO, false)
}

fn streamed_fixture(
    status: &str,
    body: Vec<u8>,
    header_delay: Duration,
    body_delay: Duration,
    chunked: bool,
) -> (
    String,
    mpsc::Receiver<(String, Value)>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (sent, received) = mpsc::channel();
    let status = status.to_string();
    let thread = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        let (header_length, length) = loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if let Some(i) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..i]);
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap();
                break (i + 4, length);
            }
        };
        while request.len() < header_length + length {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
        }
        let headers = String::from_utf8_lossy(&request[..header_length]).into_owned();
        let payload =
            serde_json::from_slice(&request[header_length..header_length + length]).unwrap();
        let _ = sent.send((headers, payload));
        thread::sleep(header_delay);
        let framing = if chunked {
            "Transfer-Encoding: chunked".to_string()
        } else {
            format!("Content-Length: {}", body.len())
        };
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{framing}\r\nConnection: close\r\nLocation: http://127.0.0.1:9/never-follow\r\n\r\n");
        let _ = stream.flush();
        thread::sleep(body_delay);
        if chunked {
            let _ = write!(stream, "{:x}\r\n", body.len());
            let _ = stream.write_all(&body);
            let _ = stream.write_all(b"\r\n0\r\n\r\n");
        } else {
            let _ = stream.write_all(&body);
        }
    });
    (endpoint, received, thread)
}

#[tokio::test]
async fn response_bounds_and_timeout_apply_while_reading_the_body() {
    for (body, body_delay, expected) in [
        (
            vec![b'x'; MAX_RESPONSE_BYTES + 1],
            Duration::ZERO,
            "exceeded",
        ),
        (b"{}".to_vec(), Duration::from_millis(1300), "timed out"),
    ] {
        let (endpoint, _, server) =
            streamed_fixture("200 OK", body, Duration::ZERO, body_delay, true);
        let profile = Profile {
            endpoint: format!("{endpoint}/v1"),
            timeout_seconds: 1,
            ..enabled()
        };
        assert!(request(&profile, "Synthetic original")
            .await
            .unwrap_err()
            .contains(expected));
        server.join().unwrap();
    }
}

#[tokio::test]
async fn both_adapters_send_selected_model_instruction_and_original_text() {
    for provider in ["lm_studio", "ollama"] {
        let response = if provider == "lm_studio" {
            json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"A structured plan."}}]})
        } else {
            json!({"done":true,"message":{"role":"assistant","content":"A structured plan."}})
        };
        let (endpoint, received, server) = fixture(
            "200 OK",
            serde_json::to_vec(&response).unwrap(),
            Duration::ZERO,
        );
        let p = Profile {
            provider: provider.into(),
            endpoint: if provider == "lm_studio" {
                format!("{endpoint}/v1")
            } else {
                endpoint
            },
            instruction: "Synthetic instruction".into(),
            ..enabled()
        };
        assert_eq!(
            request(&p, "Synthetic German: Wünsche.").await.unwrap(),
            "A structured plan."
        );
        let (headers, body) = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(headers.starts_with(if provider == "lm_studio" {
            "POST /v1/chat/completions "
        } else {
            "POST /api/chat "
        }));
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        assert_eq!(body["model"], "owned-fixture");
        assert_eq!(body["messages"][0]["content"], "Synthetic instruction");
        assert_eq!(body["messages"][1]["content"], "Synthetic German: Wünsche.");
        assert_eq!(body["stream"], false);
        assert_eq!(
            if provider == "lm_studio" {
                &body["max_tokens"]
            } else {
                &body["options"]["num_predict"]
            },
            &json!(1024)
        );
        server.join().unwrap();
    }
}
#[tokio::test]
async fn failures_are_bounded_and_do_not_expose_server_bodies() {
    for (status, body) in [
        ("302 Found", b"private redirect detail".to_vec()),
        ("401 Unauthorized", b"private key detail".to_vec()),
        (
            "500 Internal Server Error",
            b"private transcript detail".to_vec(),
        ),
        ("200 OK", b"not JSON private detail".to_vec()),
        ("200 OK", vec![b'x'; MAX_RESPONSE_BYTES + 1]),
    ] {
        let (endpoint, _, server) = fixture(status, body, Duration::ZERO);
        let p = Profile {
            endpoint: format!("{endpoint}/v1"),
            ..enabled()
        };
        let error = request(&p, "Original fixture text").await.unwrap_err();
        assert!(!error.contains("private"));
        if status != "200 OK" {
            assert!(error.contains("server rejected"));
        }
        server.join().unwrap();
    }
    assert!(request(&Profile::default(), "Original")
        .await
        .unwrap_err()
        .contains("disabled"));
    assert!(request(&enabled(), &"x".repeat(MAX_TEXT_BYTES + 1))
        .await
        .unwrap_err()
        .contains("unchanged"));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    drop(listener);
    assert!(request(
        &Profile {
            endpoint,
            ..enabled()
        },
        "Original"
    )
    .await
    .unwrap_err()
    .contains("unchanged"));
}
#[tokio::test]
async fn timeout_and_cancellation_preserve_input_and_allow_another_preview() {
    let (endpoint, received, server) =
        fixture("200 OK", b"{}".to_vec(), Duration::from_millis(1300));
    let p = Profile {
        endpoint: format!("{endpoint}/v1"),
        timeout_seconds: 1,
        ..enabled()
    };
    assert!(request(&p, "Original")
        .await
        .unwrap_err()
        .contains("timed out"));
    assert_eq!(
        received.recv().unwrap().1["messages"][1]["content"],
        "Original"
    );
    server.join().unwrap();
    let (endpoint, received, server) =
        fixture("200 OK", b"{}".to_vec(), Duration::from_millis(300));
    let p = Profile {
        endpoint: format!("{endpoint}/v1"),
        ..enabled()
    };
    let service = std::sync::Arc::new(PreviewService::default());
    let running = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .process("owned-request".into(), p, "Original".into())
                .await
        })
    };
    tokio::task::spawn_blocking(move || received.recv_timeout(Duration::from_secs(3)))
        .await
        .unwrap()
        .unwrap();
    service.cancel("different-request");
    assert!(service
        .process("another".into(), enabled(), "Other".into())
        .await
        .unwrap_err()
        .contains("already running"));
    service.cancel("owned-request");
    assert!(running.await.unwrap().unwrap_err().contains("cancelled"));
    assert!(service
        .process("next".into(), Profile::default(), "Original".into())
        .await
        .unwrap_err()
        .contains("disabled"));
    server.join().unwrap();
}
