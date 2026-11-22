# Shisan-kanri

個人の資産運用の管理リポジトリ。中枢データは `data/portfolio.json`、計画と投資ルールは `docs/project-v2.md`、前提の一覧は `docs/premises.md`。

## 推奨・判断は必ず工程分離で
売買・基本配分・ルール・損失の許容幅・生活防衛資金など、利用者がお金を動かす判断にかかわる回答と、週次レビューは、`.claude/skills/pf-decision/SKILL.md` の手順で、役割を分けたサブエージェント（`.claude/agents/pf-*.md`）に通してから利用者に届ける。統括（メインのClaude）1人の判断で推奨を送らない。

## 運用の決まり
- データだけの変更と、判断の記録（`docs/reviews/`）は main に直接 push してよい。コードと計画書（`docs/project-v2.md`・`docs/premises.md`）、この CLAUDE.md・`.claude/` の変更はブランチと PR まで。マージは利用者の承認後。
- ClaudeはAnthropic製。Anthropic株の将来性は評価しない（利益相反）。
- 利用者への報告は日本語で、結論・判断基準・推奨が変わる条件・未確認の前提を必ず書く。
