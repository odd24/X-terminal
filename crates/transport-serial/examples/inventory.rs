fn main() {
    match transport_serial::device::inventory() {
        Ok(inventory) => println!(
            "Read-only serial inventory: {} identified interfaces, {} unidentified ports, {} metadata failures; no port opened; instance IDs and paths omitted",
            inventory.devices.len(),
            inventory.unidentified_ports.len(),
            inventory.metadata_failures
        ),
        Err(error) => {
            eprintln!("Read-only serial inventory failed: {:?}", error.kind());
            std::process::exit(1);
        }
    }
}
