# Pin 131 CI retrigger

CI retrigger for the lb_stats `sort_by_key` clippy fix (b1d740e).
The beta rust job failed its `cargo clippy -D warnings` gate on 598bd343 at
`main.rs:2725` (`sort_by` on a plain key); the fix sorts with
`sort_by_key(|(_, count)| std::cmp::Reverse(*count))`.
