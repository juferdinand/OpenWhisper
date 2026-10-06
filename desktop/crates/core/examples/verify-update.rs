use std::{fs, process};

fn main() {
    if let Err(error) = verify() {
        eprintln!("Update verification failed: {error}");
        process::exit(1);
    }
    println!("Update signature and version verified.");
}

fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err(
            "Usage: verify-update <tauri.conf.json> <package> <signature> <version>".into(),
        );
    }
    let config: serde_json::Value = serde_json::from_slice(&fs::read(&args[0])?)?;
    let public = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Missing update public key")?;
    if config["plugins"]["updater"]["requireSignedVersion"] != true {
        return Err("Signed update versions must be required".into());
    }
    whisperfree_core::updates::verify_artifact(
        &fs::read(&args[1])?,
        &fs::read_to_string(&args[2])?,
        public,
        &args[3],
    )?;
    Ok(())
}
