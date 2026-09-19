# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题与孔位漂移校正记录。

## 启动

```bash
PORT=3019 node server.js
```

## 目录结构

- `server.js`：HTTP 路由与请求编排
- `lib/db-store.js`：数据落盘（`data/db.json` 的读写、初始数据、ID 生成）
- `lib/correction-service.js`：孔位漂移校正规则、批次应用、幂等请求记录（业务模块，不碰文件）
- `scripts/test-correction.js`：校正批次端到端验证

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`
- `POST /tunes/:id/correction-batches`：孔位漂移校正批次
- `GET /tunes/:id/correction-batches`：某曲目已应用的校正批次
- `GET /correction-requests/:requestId`：按幂等键回放某次校正请求的首次结果

## 孔位漂移校正批次

一次选择同一曲目的一批**未解决**问题，施加统一的拍号偏移和轨道偏移。

请求体：

```json
{
  "requestId": "client-unique-key-001",
  "issueIds": ["issue_a", "issue_b"],
  "beatOffset": 2,
  "laneOffset": -1
}
```

- `beatOffset` / `laneOffset` 必须为整数；`issueIds` 必须为非空且不重复的数组。
- 成功后更新批内每个问题的 `beat` / `lane`，原值以只读形式追加到问题的
  `corrections` 列表（含批次ID、请求ID、from/to、偏移量、应用时间），区间的
  `checked` 核对状态不变。
- 同一 `requestId` 的重复请求一律返回**首次**结果（无论成功还是 409），
  不二次应用偏移；请求记录落盘，服务重启后仍可追溯/回放。

以下任一情况整批驳回，返回 `409 Conflict` 且**问题状态与记录完全不变**
（冲突逐条列在 `conflicts` 中）：

| reason | 含义 |
| --- | --- |
| `issue_not_found` | 问题不存在 |
| `tune_mismatch` | 问题不属于该曲目 |
| `issue_resolved` | 问题已解决 |
| `position_missing` | 问题缺少拍号或轨道，无法漂移 |
| `out_of_section` | 偏移后超出所属区间的拍号或轨道范围 |
| `overlap` | 与同区间其他问题（含本批其他问题）的目标孔位重合 |

请求示例：

```bash
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/correction-batches \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"batch-001","issueIds":["issue_demo"],"beatOffset":1,"laneOffset":0}'
```

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```
