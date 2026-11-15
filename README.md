# dsh-decision-engine

Published fork: **`@leonhardthust/dsh-decision-engine`**. Based on the MIT-licensed upstream by [zuosus](https://github.com/zuosus/dsh-decision-engine). Do not enable both packages at once. See [publishing and installation](docs/releasing.md).

![dsh-decision-engine — decision engine for DeepSeek Harness](docs/assets/hero.jpeg)

**Free decision model usage provided**

[website](https://dsh.zuos.us/dsh-decision-engine/) ·
[config.example.yml](config.example.yml) · [DECISIONS.md](DECISIONS.md)

[简体中文](./README.zh.md)

A judgement layer for DeepSeek Harness: a cheap decision model judges before the
main model acts.

## Features

**Eight decision points**

- tool authorization
- model routing
- delegation
- compaction
- turn continuation
- retrieval necessity
- skill selection
- COT translation gate

**Modes**: off · observe · enforce

**Providers**: system one · bamboonode · 硅基流动 SiliconFlow (CN / Global) ·
Alibaba Bailian · TokenHub · Perplexity · OpenRouter · custom base URL

**Safety level (how often to ask)**: Don't ask · Ask less · Default · Ask more
(none of the four changes permission-mandated approval or denial)

**UI**: config page with collapsible sections · Decisions tab · stats ·
readable approval card · sharded decision logs (by date / session / workspace) with retention

| Config page | Decisions tab |
|---|---|
| ![config page](docs/assets/config-page.png) | ![decisions tab](docs/assets/decisions-tab.png) |

> Screenshots predate the collapsible-section layout (DEC-051).

**Token saving**: exact cache · read-only tools bypass · state trimming

**Safety layers**: trusted host context → tool effects → mandatory permissions → model advisory → soft review tolerance → host outcome audit.
Unknown high-impact calls fail closed; Auto still runs decision review. Soft asks use a selected host model (including reasoning effort), the session model, allow, or deny.
Neither model review nor the allow fallback can replace mandatory approval.

See the [security revision and verification notes](docs/security-revision.md). The plugin remains disabled by default; observation mode does not enforce protection.

## License

MIT
