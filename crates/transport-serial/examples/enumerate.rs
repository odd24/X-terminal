fn main() {
    match transport_serial::enumerate() {
        Ok(ports) => {
            println!(
                "Enumerated {} ports (read-only; no port opened)",
                ports.len()
            );
            for port in ports {
                println!("{} {:?}", port.port_name, port.port_type);
            }
        }
        Err(error) => {
            eprintln!("Enumeration failed: {error}");
            std::process::exit(1);
        }
    }
}
