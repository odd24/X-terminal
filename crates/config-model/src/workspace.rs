use super::*;
use std::collections::HashSet;

pub fn valid_layout_name(name: &str) -> bool {
    !name.trim().is_empty()&&name.encode_utf16().count()<=64&&!name.chars().any(|c|c.is_control()||matches!(c,'\u{061c}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceGroup {
    pub id: Uuid,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceTab {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub group_id: Option<Uuid>,
}
/// Layout metadata only. Slot IDs cannot be used as connection or input request IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub groups: Vec<WorkspaceGroup>,
    pub tabs: Vec<WorkspaceTab>,
    pub selected_tab: Option<Uuid>,
    pub navigation_open: bool,
}
impl Workspace {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_nil()
            || !valid_layout_name(&self.name)
            || self.groups.len() > 16
            || self.tabs.is_empty()
            || self.tabs.len() > 64
        {
            return Err(ValidationError("workspace limits/name"));
        }
        let mut groups = HashSet::new();
        for g in &self.groups {
            if g.id.is_nil() || !valid_layout_name(&g.name) || !groups.insert(g.id) {
                return Err(ValidationError("workspace group"));
            }
        }
        let mut tabs = HashSet::new();
        for t in &self.tabs {
            if t.id.is_nil()
                || t.profile_id.is_nil()
                || !tabs.insert(t.id)
                || t.group_id.is_some_and(|g| !groups.contains(&g))
            {
                return Err(ValidationError("workspace tab"));
            }
        }
        if self.selected_tab.is_some_and(|id| !tabs.contains(&id)) {
            return Err(ValidationError("workspace selected tab"));
        }
        Ok(())
    }
}
