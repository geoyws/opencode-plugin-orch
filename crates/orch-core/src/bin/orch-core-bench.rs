use orch_core::{RunActivity, RunStatus, project_activity};
use std::hint::black_box;
use std::time::Instant;

fn main() {
    let runs: Vec<_> = (0..64)
        .map(|index| RunActivity {
            id: format!("run_{index}"),
            workflow: format!("workflow-{index}"),
            status: RunStatus::Running,
            created_at: index * 1_000,
            running_agents: 4,
            tokens: Some(index * 100),
            max_tokens: Some(100_000),
        })
        .collect();
    let iterations = 100_000;
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(project_activity(&runs, 120_000));
    }
    let elapsed = started.elapsed();
    println!(
        "orch-core activity projection: {iterations} iterations in {:?} ({:.0} ns/op)",
        elapsed,
        elapsed.as_nanos() as f64 / iterations as f64
    );
}
