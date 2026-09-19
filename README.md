# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

## 启动

```bash
PORT=3019 node server.js
```

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
- `POST /tunes/:id/corrections`（孔位漂移校正批次）
- `GET /tunes/:id/corrections`（只读校正批次记录）

## 孔位漂移校正批次

`POST /tunes/:id/corrections` 对同曲目一批未解决问题统一施加拍号偏移与轨道偏移：

```json
{
  "requestId": "corr-20260919-01",
  "issueIds": ["issue_demo"],
  "beatOffset": 2,
  "laneOffset": -1
}
```

- `requestId` 为重复请求标识：同一标识永远返回首次结果（成功返回 201，首次为整批冲突则返回 409）；标识记录落盘，服务重启后仍可重放。标识被用于其他曲目时返回 409。
- 以下任一情况整批返回 409，问题状态、孔位、区间核对状态（`checked`/`note`）均不变，响应体 `conflicts` 给出每条原因：
  - 问题不存在或不属于该曲目（`issue_not_in_tune`）
  - 问题已解决（`issue_resolved`）
  - 偏移后拍号或轨道超出问题所属区间（`out_of_section`）
  - 偏移后与同区间其他问题（含已解决历史、批内互相）孔位重合（`overlap`）
- 成功后更新该批问题的 `beat`/`lane`；原值写入每问题只追加的只读 `corrections` 历史，并汇总为 `correctionBatches` 批次记录（含 `requestId`、偏移量、前后值、时间），均可通过 `GET /tunes/:id/corrections` 与 `GET /issues` 追溯。问题 `status`/`resolvedAt` 不变。

校正规则见 `lib/correction.js`，数据落盘见 `lib/db.js`（存储文件 `data/db.json`，可用环境变量 `DB_FILE` 覆盖）。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```
