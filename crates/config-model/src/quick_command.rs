use super::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CommandEnding {
    None,
    Cr,
    Lf,
    Crlf,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QuickCommand {
    pub id: Uuid,
    pub name: String,
    pub group: String,
    pub template: String,
    pub ending: CommandEnding,
}
impl std::fmt::Debug for QuickCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QuickCommand")
            .field("id", &self.id)
            .field("template_units", &self.template.encode_utf16().count())
            .field("ending", &self.ending)
            .finish_non_exhaustive()
    }
}
pub fn command_variables(template: &str) -> Vec<String> {
    let bytes = template.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] != b'{' || bytes[index + 1] != b'{' {
            index += 1;
            continue;
        }
        let start = index + 2;
        let mut end = start;
        if start < bytes.len() && (bytes[start].is_ascii_alphabetic() || bytes[start] == b'_') {
            while end < bytes.len()
                && end - start < 32
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
            {
                end += 1;
            }
            if end + 1 < bytes.len() && bytes[end] == b'}' && bytes[end + 1] == b'}' {
                let name = &template[start..end];
                if !result.iter().any(|v| v == name) {
                    result.push(name.to_owned());
                    if result.len() > 16 {
                        return result;
                    }
                }
                index = end + 2;
                continue;
            }
        }
        index += 1;
    }
    result
}

impl QuickCommand {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_nil()
            || !valid_layout_name(&self.name)
            || self.name.trim() != self.name
            || !valid_layout_name(&self.group)
            || self.group.trim() != self.group
            || self.template.is_empty()
            || self.template.encode_utf16().count() > 8192
            || command_variables(&self.template).len() > 16
        {
            return Err(ValidationError("quick command limits/shape"));
        }
        Ok(())
    }
}
