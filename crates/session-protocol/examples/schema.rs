fn main() {
    let schema = serde_json::json!({
        "hello": schemars::schema_for!(session_protocol::Hello),
        "request": schemars::schema_for!(session_protocol::RequestEnvelope),
        "response": schemars::schema_for!(session_protocol::Response),
    });
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}
