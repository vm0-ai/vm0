# VAS Benchmark Results

## Summary Table

| Scenario | Approach | Operation | Size (MB) | Time (s) | Change % |
|----------|----------|-----------|-----------|----------|----------|
| python_project | full_snapshot | initial_checkpoint | 0.08 | 0.20 | 0% |
| python_project | full_snapshot | incremental_checkpoint | 0.08 | 0.18 | 5% |
| python_project | full_snapshot | restore | 49.99 | 0.23 | 0% |
| python_project | restic_vas | initial_checkpoint | 50.11 | 0.82 | 0% |
| python_project | restic_vas | incremental_checkpoint | 2.59 | 0.73 | 5% |
| python_project | restic_vas | restore | 49.99 | 0.77 | 0% |
| ml_artifacts | full_snapshot | initial_checkpoint | 200.03 | 3.40 | 0% |
| ml_artifacts | full_snapshot | incremental_checkpoint | 200.03 | 3.36 | 5% |
| ml_artifacts | full_snapshot | restore | 200.00 | 0.69 | 0% |
| ml_artifacts | restic_vas | initial_checkpoint | 200.05 | 0.96 | 0% |
| ml_artifacts | restic_vas | incremental_checkpoint | 1.21 | 0.77 | 5% |
| ml_artifacts | restic_vas | restore | 200.00 | 0.84 | 0% |
| mixed_workspace | full_snapshot | initial_checkpoint | 105.02 | 1.80 | 0% |
| mixed_workspace | full_snapshot | incremental_checkpoint | 105.02 | 1.79 | 5% |
| mixed_workspace | full_snapshot | restore | 106.28 | 0.38 | 0% |
| mixed_workspace | restic_vas | initial_checkpoint | 106.34 | 0.84 | 0% |
| mixed_workspace | restic_vas | incremental_checkpoint | 0.08 | 0.70 | 5% |
| mixed_workspace | restic_vas | restore | 106.28 | 0.77 | 0% |

## Analysis


### python_project

- **Incremental size savings**: -3066.4%
- **Incremental time savings**: -303.0%

### mixed_workspace

- **Incremental size savings**: 99.9%
- **Incremental time savings**: 60.8%

### ml_artifacts

- **Incremental size savings**: 99.4%
- **Incremental time savings**: 77.1%