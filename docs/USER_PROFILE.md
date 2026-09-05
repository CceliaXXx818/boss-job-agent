# 候选人画像（示例/匿名版）

> 本文件是**通用示例**，供了解"画像如何驱动匹配与 AI 打分"。作者实际画像只存在于本地 `config/candidate.json`（不提交）。
> 数值与项目均为虚构示例，不代表任何真实个人。

```yaml
candidate:
  experience_years: 5        # 示例：总产品经验
  ai_product_years: 2        # 示例：专注 AI 产品经验

target:
  cities:
    - 示例城市A
    - 示例城市B
  roles:
    - AI产品经理
    - Agent产品经理
    - 对话式AI产品经理

exclude:
  cities: []                 # 示例：无排除城市
  roles:
    - 纯数据标注
    - 纯销售岗位
  work_modes:
    - 长期驻外

application:
  minimum_match_score: 75
  daily_minimum: 10
  daily_maximum: 30
  weekdays_only: true
  start_time: "09:30"
  end_time: "17:30"
  report_time: "18:00"

evidence:
  projects:                  # 示例项目（占位）
    - 示例：智能客服问答产品0-1
    - 示例：RAG 知识库助手
    - 示例：语音机器人流程产品
```
