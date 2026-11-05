//! Independent full-buffer probe using the production parser configuration.
//! No service API or production screen visibility is expanded by this example.
use serde::Deserialize;
use serde_json::{Value, json};
use session_core::screen::Screen;
use std::num::NonZeroU16;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    rows: u16,
    cols: u16,
    steps: Vec<Action>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Action {
    Write { text: String },
    Resize { rows: u16, cols: u16 },
}

fn dimensions(rows: u16, cols: u16) -> (NonZeroU16, NonZeroU16) {
    assert!((1..=200).contains(&rows) && (2..=500).contains(&cols));
    (
        NonZeroU16::new(rows).unwrap(),
        NonZeroU16::new(cols).unwrap(),
    )
}

fn color(value: vt100::Color) -> Value {
    match value {
        vt100::Color::Default => Value::Null,
        vt100::Color::Idx(index) => json!(["index", index]),
        vt100::Color::Rgb(r, g, b) => json!(["rgb", r, g, b]),
    }
}

fn snapshot(parser: &mut vt100::Parser, production: &Screen) -> Value {
    // set_scrollback can grow old rows, so inspect a clone. Never let the
    // observer alter the layout used by a later resize in this sequence.
    let mut inspected = parser.screen().clone();
    let screen = &mut inspected;
    let (rows, cols) = screen.size();
    let history = screen.scrollback_len();
    assert!(history <= 512);
    let cursor = screen.cursor_position();
    let alternate = screen.alternate_screen();
    let mut lines = Vec::new();
    for index in 0..history + usize::from(rows.get()) {
        screen.set_scrollback(history.saturating_sub(index));
        let row = u16::try_from(index.saturating_sub(history)).unwrap();
        let cells: Vec<_> = (0..cols.get())
            .map(|col| {
                let cell = screen.cell(row, col).unwrap();
                json!({
                    "text": cell.contents(),
                    "width": if cell.is_wide_continuation() { 0 } else if cell.is_wide() { 2 } else { 1 },
                    "fg": color(cell.fgcolor()), "bg": color(cell.bgcolor()),
                    "bold": cell.bold(), "dim": cell.dim(), "italic": cell.italic(),
                    "underline": cell.underline(), "inverse": cell.inverse(),
                })
            })
            .collect();
        lines.push(json!({"wrapsToNext": index + 1 < history + usize::from(rows.get()) && screen.row_wrapped(row), "cells": cells}));
    }
    screen.set_scrollback(0);
    assert_eq!(screen.cursor_position(), production.cursor());
    assert_eq!(screen.alternate_screen(), production.alternate());
    let mut viewport: Vec<_> = screen.rows(0, cols.get()).collect();
    while viewport.last().is_some_and(String::is_empty) {
        viewport.pop();
    }
    assert_eq!(viewport.join("\n"), production.physical_contents());
    json!({"rows": rows.get(), "cols": cols.get(), "history": history,
        "cursor": cursor, "alternate": alternate, "lines": lines})
}

fn main() {
    let path = std::env::args().nth(1).expect("fixture path required");
    let fixtures: Vec<Fixture> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let results: Vec<_> = fixtures
        .into_iter()
        .map(|fixture| {
            let (rows, cols) = dimensions(fixture.rows, fixture.cols);
            let mut parser = vt100::Parser::new(rows, cols, 512);
            let mut production = Screen::new(rows.get(), cols.get()).unwrap();
            let mut snapshots = vec![snapshot(&mut parser, &production)];
            for action in fixture.steps {
                match action {
                    Action::Write { text } => {
                        // Same bounded UTF-8 chunks as Screen::push accepts; byte boundaries
                        // deliberately include partial multibyte/control sequences.
                        for chunk in text.as_bytes().chunks(31) {
                            parser.process(chunk);
                            production.push(chunk).unwrap();
                        }
                    }
                    Action::Resize { rows, cols } => {
                        let (rows, cols) = dimensions(rows, cols);
                        parser.set_size(rows, cols);
                        production.resize(rows.get(), cols.get()).unwrap();
                    }
                }
                snapshots.push(snapshot(&mut parser, &production));
            }
            json!({"name": fixture.name, "snapshots": snapshots})
        })
        .collect();
    println!("{}", serde_json::to_string(&results).unwrap());
}
