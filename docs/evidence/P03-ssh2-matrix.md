# P03 SSH2 支持/验证矩阵

日期 2026-11-03（Asia/Shanghai），Codex 执行；基线 77f76f6 + P03 工作树。CPU/系统沿用 P01 环境。命令 `cargo test -p transport-ssh2 --locked -- --nocapture`；服务只监听 127.0.0.1 的系统分配端口，密钥和随机口令只在测试进程内存中生成。

| 能力 | 结果 | 证据和实际范围 |
|---|---|---|
| 密码认证、错误密码 | PASS（协议） | 回环测试拒绝错误输入，接受随机测试口令 |
| Ed25519 公钥认证、错误 key | PASS（协议） | 服务校验实际签名和预期公钥；错误 key 拒绝 |
| 带口令私钥 | PASS（内存/协议） | 内存生成加密 key，错误口令解密失败，正确解密后完成公钥认证；文件格式导入另测 |
| keyboard-interactive | PASS（协议） | echo=false 的挑战，错误答案拒绝、正确答案成功；17 提示超限拒绝，不交给回调 |
| 主机 key 变化/未知 | PASS（协议） | 不匹配 pin 握手失败，空 pin 在连接前拒绝 |
| PTY/resize/shell | PASS（消息） | xterm-256color、80×24、resize 100×30；合成 echo，不是真实 OS PTY |
| exec stdout/stderr/退出码 | PASS（消息） | 独立 channel，合成成功 0/失败 7；不会读取交互 shell 的 cwd |
| channel 拒绝、输出/命令限额 | PASS（协议） | reject、>1 MiB 输出、>64 KiB 命令被拒，失败后独立 exec 仍可用 |
| exec 超时 | PASS（协议） | stall 约 5 秒返回错误并关闭 channel；不自动重放 |
| 保活时连接存续 | PASS（有限） | 1 秒间隔，等待 2.2 秒后仍能 echo；不是断网/保活超时验收 |
| 主动断开 | PASS（协议） | fixture 收到控制输入后关闭连接，客户端观察 channel 结束 |
| KEX | 实测一个 | mlkem768x25519-sha256；其他 KEX 未执行 |
| 主机 key | 实测 Ed25519 | RSA/ECDSA/主机证书未执行；原型策略拒绝证书 |
| cipher | 实测一个 | chacha20-poly1305@openssh.com |
| MAC 元数据 | 观测值 | hmac-sha2-512-etm@openssh.com 双向；当前 AEAD cipher 使用其自身认证标签，不代表该 MAC 实际参与独立认证 |
| strict-kex | 实测 true | 来自 kex_done，未记录共享秘密 |
| RSA 认证、ECDSA、压缩、其他算法 | 未执行 | 特性已编译不等于组合通过 |
| OpenSSH/Linux/UNIX、vim/top/less/tmux | BLOCKED | 本机无 sshd 服务/可用 WSL distro，未提供隔离 Linux 服务器；不擅自安装系统服务 |
| 真正网络断开、长稳与实机 | BLOCKED | 无授权真实测试目标 |

4 个集成测试最终通过，用时约 5.06 秒；格式及 clippy 无警告通过。首次编译发现 russh 0.65 公钥类型/Names 的导出位置与旧示例不同，按实际源码修正后通过，未修改第三方源码。
