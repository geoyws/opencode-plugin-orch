use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
    BudgetExhausted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RunActivity {
    pub id: String,
    pub workflow: String,
    pub status: RunStatus,
    pub created_at: u64,
    pub running_agents: u32,
    pub tokens: Option<u64>,
    pub max_tokens: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ActivityProjection {
    pub rows: Vec<String>,
    pub active_workflows: usize,
    pub running_agents: u32,
}

pub fn format_elapsed(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1_000;
    let hours = total_seconds / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m {seconds}s")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

pub fn project_activity(runs: &[RunActivity], now: u64) -> ActivityProjection {
    let mut active: Vec<_> = runs
        .iter()
        .filter(|run| matches!(run.status, RunStatus::Running | RunStatus::Paused))
        .collect();
    active.sort_by_key(|run| run.created_at);
    let running_agents = active.iter().map(|run| run.running_agents).sum();
    let rows = active
        .iter()
        .map(|run| {
            let status = match run.status {
                RunStatus::Running => "running",
                RunStatus::Paused => "paused",
                _ => unreachable!("terminal runs were filtered"),
            };
            let agent_label = if run.running_agents == 1 {
                "agent"
            } else {
                "agents"
            };
            let token_text = run.tokens.map(|tokens| match run.max_tokens {
                Some(max) => format!(" · {tokens}/{max} tok"),
                None => format!(" · {tokens} tok"),
            });
            format!(
                "{} · {} · {} elapsed · {} {}{}",
                run.workflow,
                status,
                format_elapsed(now.saturating_sub(run.created_at)),
                run.running_agents,
                agent_label,
                token_text.unwrap_or_default()
            )
        })
        .collect();
    ActivityProjection {
        active_workflows: active.len(),
        running_agents,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_elapsed_time_agents_and_tokens() {
        let projection = project_activity(
            &[
                RunActivity {
                    id: "run_1".into(),
                    workflow: "parallel-review".into(),
                    status: RunStatus::Running,
                    created_at: 10_000,
                    running_agents: 3,
                    tokens: Some(120),
                    max_tokens: Some(1_000),
                },
                RunActivity {
                    id: "run_2".into(),
                    workflow: "test-fix-loop".into(),
                    status: RunStatus::Paused,
                    created_at: 70_000,
                    running_agents: 0,
                    tokens: None,
                    max_tokens: None,
                },
            ],
            130_000,
        );
        assert_eq!(projection.active_workflows, 2);
        assert_eq!(projection.running_agents, 3);
        assert_eq!(
            projection.rows,
            vec![
                "parallel-review · running · 2m 0s elapsed · 3 agents · 120/1000 tok",
                "test-fix-loop · paused · 1m 0s elapsed · 0 agents",
            ]
        );
    }

    #[test]
    fn elapsed_format_is_stable() {
        assert_eq!(format_elapsed(3_661_900), "1h 1m 1s");
        assert_eq!(format_elapsed(12_999), "12s");
    }
}
