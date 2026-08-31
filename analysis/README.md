# ctp-v2 计算表型分析

分析环境与采集应用分离。请使用 Python 3.12 创建虚拟环境；当前主机的 Python 3.14 不作为正式分析运行时。

```powershell
py -3.12 -m venv .venv-phenotype
.\.venv-phenotype\Scripts\python -m pip install -r analysis\requirements-lock.txt

.\.venv-phenotype\Scripts\python analysis\prepare_stan_data.py expedition-trials-123456.csv output\phenotype\pilot.json
.\.venv-phenotype\Scripts\python analysis\fit_phenotype.py output\phenotype\pilot.json --model pilot --output output\phenotype\fit
.\.venv-phenotype\Scripts\python analysis\power_group_wave.py
```

本项目锁定 CmdStan 2.38.0（`.cmdstan-phenotype/cmdstan-2.38.0`）和 RTools45（`C:/rtools45`）。
`fit_phenotype.py` 会自动配置两者，不依赖系统 PATH；可用 `smoke_test_models.py` 重新执行双模型工作链验收。

- `phenotype_pilot.stan`：T0–T1 双剂量预试，使用受试者稳定效应和会话状态偏离。
- `phenotype_longitudinal_ar1.stan`：正式 T0–T8 分析，会话状态按受试者内部波次顺序使用正则化 AR(1)。
- 所有社会证据变量来自服务器验收过的序列库；不再逐人搜索学习率。
- `0.3 × T0 SVS 标准差` 只是预注册的最小相关变化阈值，不应在外部临床锚定前解释为临床显著变化。
