use serde::Deserialize;
use session_core::screen::Screen;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    name: String,
    rows: u16,
    cols: u16,
    text: String,
    chunk_sizes: Vec<usize>,
    resize: Option<Dimensions>,
}

#[derive(Deserialize)]
struct Dimensions {
    rows: u16,
    cols: u16,
}

fn main() {
    let file = std::env::args().nth(1).expect("fixture path required");
    let fixtures: Vec<Fixture> = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let mut results = vec![];
    for fixture in fixtures {
        let mut screen = Screen::new(fixture.rows, fixture.cols).unwrap();
        let bytes = fixture.text.as_bytes();
        let mut offset = 0;
        let mut index = 0;
        while offset < bytes.len() {
            let size = fixture.chunk_sizes[index % fixture.chunk_sizes.len()];
            let end = (offset + size).min(bytes.len());
            screen.push(&bytes[offset..end]).unwrap();
            offset = end;
            index += 1;
        }
        if let Some(size) = fixture.resize {
            screen.resize(size.rows, size.cols).unwrap();
        }
        results.push(serde_json::json!({
            "name": fixture.name, "contents": screen.contents(),
            "cursor": screen.cursor(), "alternate": screen.alternate(),
        }));
    }
    println!("{}", serde_json::to_string(&results).unwrap());
}
