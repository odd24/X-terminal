# russh 0.65.0 本地信任检查补丁

- 上游：warp-tech/russh，crate 0.65.0；归档记录 commit `183a22e8f8f490fa09b6eb7bd044ef99d8c4414f`，路径 `russh`。
- 原始 crates.io 归档 SHA-256：`3bb77a4b259312b2abbc541bca1c13cb4e9b61c560a7fd894068c3b92e0c9dc3`。已核对本地下载归档与原 Cargo.lock 一致。
- 保留上游全部 59 个 src 文件、README 及版权头；LICENSE 为 Apache 官方 2.0 全文。归档没有独立 LICENSE/NOTICE 文件。
- Cargo.toml 使用归档规范化版本，仅移除未复制的 examples/tests/benches 目标和开发依赖。生产依赖与 feature 不变；本目录排除在主 workspace 外，通过根 `[patch.crates-io]` 全局替代同版本依赖，生产与测试使用同一补丁。
- 唯一生产行为改动：`src/client/mod.rs` 将初始握手分支中的 `check_server_key` 提到初始/rekey 共用路径，位于交换签名验证后、安装新密钥和排放 pending channel 数据前。证书仍替代裸公钥检查，不引入隐式信任；现有包装器继续拒绝证书。
- 为遵守仓库不提交私钥规则，`src/helpers.rs`、`src/keys/mod.rs` 的上游测试模块和后者的文档示例、`src/keys/format/tests.rs` 的固定私钥测试材料被省略；均不影响非 test 生产逻辑。本分发不支持运行上游自身完整测试，使用主仓库随机合成密钥的回归，不提交固定私钥。
- 未升级加密实现、算法或改变原有 key exchange。库的 `kex_done` 回调顺序保留。
- `rekey-trust.patch` 是相对原 crate 的 UTF-8/LF 零上下文补丁，复核使用 `git apply --check --unidiff-zero`；README 仅规范行尾空白。
- 回归：主仓库 transport-ssh2 的 `production_rekey_*`，以及 session-service 的 `rekey_reloads_*`；补丁前已观察到两项真实 FAIL。
- 后续升级须先核对上游是否修复、运行同一负向/并发回归，再移除本地 patch。不能直接回退为绕过 rekey 信任检查的版本。

关联 ADR-019 / P09。具体运行结果以 docs/records/P09.md 为准；本地补丁不是独立第三方安全审计结论。
