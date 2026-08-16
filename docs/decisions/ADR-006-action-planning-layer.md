# ADR-006：语言模型动作规划层

- 状态：已接受
- 日期：2026-08-15

## 背景

作者目前要逐个手动建立交互组、填写关键状态描述，才能驱动关键帧与过渡生成。规划层要把作者的一句话意图（如“女孩拿起蓝色杯子”）自动整理成少量可编辑、可确认的关键状态，作者确认后再落到镜头。它需要在不破坏现有镜头格式、不触发付费生成的前提下，作为独立的一层接入。

## 决策

1. 计划草案作为独立资源存储，持久化到 `work/plans/`（Git 忽略），**不扩展通用镜头格式**；已应用结果复用现有 `InteractionGroup` + `VisualKeyframe` + `Transition`。
2. `Planner` 采用供应商中立 ABC + registry，镜像 `GenerationAdapter` / `AdapterRegistry`；本期只提供 deterministic `mock`，云端 Adapter 与前端 UI 后续接入。
3. 生成草案采用同步接口：`POST /api/action-plans` 直接返回草案，`GET /api/action-plans/{id}` 查询，`POST /api/action-plans/{id}/apply` 在作者确认后应用到镜头。
4. 每个规划步骤至少含帧号、成员 ID、状态描述、到下一状态的动作描述和是否需要交互组；输出经 Pydantic 校验，不包含供应商参数。
5. `apply` 是纯函数（无 I/O），只在作者确认后把草案物化为交互组与关键状态，不触发任何图像/视频生成。

## 结果

作者意图能转成可确认的结构化草案并落地为交互组；计划与已应用结果刷新后可追溯；规划层与生成层解耦，后续可无痛把 mock 替换为云端 Planner，或补充异步任务与前端编辑界面。
