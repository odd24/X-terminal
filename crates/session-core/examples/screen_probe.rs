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
    #[serde(default)]
    steps: Vec<Action>,
    #[serde(default)]
    physical: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Action {
    Write { text: String },
    Resize { rows: u16, cols: u16 },
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
        for step in fixture.steps {
            match step {
                Action::Write { text } => screen.push(text.as_bytes()).unwrap(),
                Action::Resize { rows, cols } => screen.resize(rows, cols).unwrap(),
            }
        }
        let contents = if fixture.physical {
            screen.physical_contents()
        } else {
            screen.contents()
        };
        results.push(serde_json::json!({
            "name": fixture.name, "contents": contents,
            "cursor": screen.cursor(), "alternate": screen.alternate(),
        }));
    }
    println!("{}", serde_json::to_string(&results).unwrap());
}
