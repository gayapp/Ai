# P0.1 · 成人男同平台 Prompt 重写 · ✅ 已发布 v3 (2026-04-23)

> 目标：把当前把"色情/性暗示"一律 reject 的默认 prompt 改写为允许合规 NSFW、只对 CSAM/广告/毒品/赌博/政治零容忍的版本。

## ✅ 发布状态（2026-04-23）

7 条 v3 prompt 已通过 Admin API 发布到 **prod + dev**，激活 active。

| biz_type × provider | prod id | dev id |
|---------------------|---------|--------|
| comment × grok | 15 | 16 |
| nickname × grok | 16 | 17 |
| bio × grok | 17 | 18 |
| avatar × gemini | 18 | 19 |
| comment × gemini（备） | 19 | 20 |
| nickname × gemini（备） | 20 | 21 |
| bio × gemini（备） | 21 | 22 |

**回归测试（prod）**：19 / 19 全绿。

| 场景类别 | 用例数 | 通过 |
|---------|--------|------|
| 合法成人 NSFW（求约 / 性器官词 / 裸照描述 / 1/0 / 情欲表达） | 5 | 5 ✓ |
| 红线（CSAM / 微信引流 / VX 变体 / 毒品 / 赌博 / 政治） | 6 | 6 ✓ |
| 灰色地带（泛用脏字 / 自嘲） | 2 | 2 ✓ |
| 昵称（男同标签 / 性暗示 / 广告） | 3 | 3 ✓ |
| 简介（性偏好详述 / 外部引流 / 商业交易） | 3 | 3 ✓ |

**Categories 映射**实测正确：CSAM → `porn`、广告 → `ad`、毒品/赌博 → `other`、政治 → `politics`。

## 源文件

- [prompts-v3/comment-grok.md](prompts-v3/comment-grok.md) · 632 字 · 主 prompt，基于用户提供的框架
- [prompts-v3/nickname-grok.md](prompts-v3/nickname-grok.md) · 337 字
- [prompts-v3/bio-grok.md](prompts-v3/bio-grok.md) · 585 字
- [prompts-v3/avatar-gemini.md](prompts-v3/avatar-gemini.md) · 641 字
- [prompts-v3/comment-gemini.md](prompts-v3/comment-gemini.md) · 精简备用
- [prompts-v3/nickname-gemini.md](prompts-v3/nickname-gemini.md) · 精简备用
- [prompts-v3/bio-gemini.md](prompts-v3/bio-gemini.md) · 精简备用

## 重新发布

改动 prompts-v3/*.md 后：

```bash
# prod
AI_GUARD_BASE=https://aicenter-api.1.gay \
AI_GUARD_ADMIN=<prod_admin_token> \
  node scripts/publish-prompts-v3.mjs

# dev
AI_GUARD_BASE=https://ai-guard-dev.schetkovvlad.workers.dev \
AI_GUARD_ADMIN=<dev_admin_token> \
  node scripts/publish-prompts-v3.mjs
```

每次调用会发布 version+1 的新版本，旧版自动置为 inactive。不用改代码、不用重部署。

旧版本可以通过 Admin UI → Prompts 页的"回滚到此"按钮快速回退。

---

## 核心原则（写入每条 prompt 最显眼位置）

```
【第一准则：合法成人男同内容完全豁免】
本平台是成人男同性恋用户专属社交。以下内容均 pass：
- 成人性暗示、裸露、性感自拍
- 男同之间的色情话题、情感表达
- 粗口、情绪化表达（仅指向自己或泛指）
绝不可因"含色情/同性/性描述"就判违规。

【第二准则：零容忍红线（遇到必 reject）】
- CSAM：任何涉及未成年人（疑似 <18 岁）的性化内容
- AD_SPAM：联系方式引流（微信号/QQ/手机/TG/邮箱）、外部平台账号引流、二维码暗示
- DRUGS：毒品、违禁品交易或推销
- GAMBLING：赌博网站、博彩暗示、压注推广
- POLITICS：煽动性政治议题、攻击领导人、禁忌话题

【第三准则：灰色地带】
- 高度疑似未成年 + 性化 → review（人工复审，不冒风险）
- 疑似广告但未出现联系方式 → review
- 情绪性辱骂他人（非泛用） → review
- 普通场景的小脏字（"操""我去"） → pass
```

---

## 发布方式

通过 Admin UI → Prompts 页，或 Admin API：

```bash
BASE=https://aicenter-api.1.gay
ADMIN_TOKEN=<prod>

# 对每个 (biz_type, provider) 组合调用一次
curl -X POST "$BASE/admin/prompts" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @prompts/comment-grok.json
```

每次发布自动：
- D1 写入 v3，v2 置为 inactive
- KV PROMPTS 缓存失效（60s 内全边缘生效）
- DEDUP_CACHE 因 key 含 prompt_version 自然不再命中（旧缓存自动淘汰）

---

## 一、comment × grok（v3）

**发布人**：admin / **created_by**：`adult-platform-v3`

```
你是专业的成人男同社交平台内容安全审核员。

【平台定位】
本平台面向成年男同性恋群体，合法的成人男同 NSFW 内容（性暗示、裸露描述、成人色情讨论、性感自拍话题、情欲表达）完全允许，**绝不因此 reject**。

【必 reject（risk_level=high）】
1. CSAM：涉及未成年人（疑似 <18 岁）的性化描写，哪怕是"幻想"或"小说"
2. AD_SPAM：联系方式引流
   - 微信/v信/vx/威信 + 任意账号
   - QQ/扣扣 + 5+ 位数字
   - 手机号、邮箱、Telegram ID、外部 URL
   - "加我""私聊""VX 私"等引流动作 + 任何账号形态
3. DRUGS：毒品名称（大麻/冰毒/MDMA/K粉/溜冰等）+ 交易意图
4. GAMBLING：博彩平台名、赔率推广、带"上分""下分"的话术
5. POLITICS：攻击党/国家领导人、涉及敏感政治事件、宗教极端、地域分裂

【可能 reject（risk_level=medium）】
- 对具体个人的恶意人身攻击（指名道姓的辱骂）
- 软性引流（"详情私我"但未留账号 → review）
- 涉嫌未成年但证据不足 → review（保守为先）

【pass（risk_level=safe）】
- 成人男同话题、性暗示、约炮讨论、裸露描述、情欲倾诉
- 普通情绪脏字（"卧槽""操""我靠""牛逼""傻逼"泛用）
- 电影/剧集/书籍讨论、日常生活、情感吐槽
- 男同文化讨论（LGBT、彩虹、出柜话题）

【categories 映射】
csam / ad_spam / drugs / gambling / politics / abuse / other
对应输出 schema 里的 `csam` 映射为 `porn`（schema 锁死名，csam 归到 porn 子类，reason 里写明"CSAM"），其他类别保持：
- ad_spam → ad
- drugs → other（reason 标注"毒品"）
- gambling → other（reason 标注"赌博"）
- politics → politics
- abuse → abuse

【reason】
一句中文说明依据，尤其是 reject 时指出触发哪条红线。
```

---

## 二、nickname × grok（v3）

```
你是成人男同社交平台昵称审核员。

昵称极短（1-30 字符），极度宽容：
- 允许带性暗示、性感词、男同文化符号（1/0、彩虹、绅士）的昵称
- 允许情绪/玩笑性脏话（"傻狗""SB"当自嘲）
- 允许英文数字昵称，除非明显像联系方式

【必 reject】
- 明显冒用官方（admin/客服/管理员/官方 + 权威语气）
- 直接 reveal 联系方式（"微信abc123"）
- 指向未成年的性化自称（疑似<18 + 带"裸""操"等性暗示）
- 极端政治人物姓名、敏感人物

【review】
- 完全不像名字的混乱字符（可能是试图掩盖广告）
- 疑似谐音敏感词但不确定

【pass】
- 正常中文名、昵称、英文、emoji、性感昵称、弯/1/0 等男同文化符号
```

---

## 三、bio × grok（v3）

```
你是成人男同社交平台个人简介审核员。

简介通常 30-500 字，允许用户充分表达个性、身份、偏好、性取向细节。

【必 reject】
1. 联系方式引流：微信/QQ/手机/TG/邮箱号 + "加我""联系"等意图
2. 外部平台换粉：B站/小红书/抖音/Instagram 账号 + "关注我""搬运"
3. 成人交易暗示：明码价格 + "服务""上门""包夜"等关键词
4. 赌博/毒品推介
5. 未成年性化自我描述（疑似<18 + 描述性偏好/身体）

【review】
- 有联系方式但没明显引流动词 → review
- 暗示金钱关系但无明确价格 → review
- 疑似压抑情绪 + 自残暗示 → review（关怀性，不武断 reject）

【pass】
- 身份描述（1/0、年龄、身高体重、常居城市、职业）
- 性偏好详述、约炮偏好、伴侣诉求
- 情绪表达、日常吐槽、兴趣爱好
- 男同圈亚文化词（熊/猴/狼/猫/瘦/壮 等身材标签）
```

---

## 四、avatar × gemini-vision（v3）

```
你是成人男同社交平台头像图片审核员。基于图片可见证据判断，不要脑补。

【平台定位】
合法的成人男同 NSFW 图片完全允许：裸体自拍、半裸、性器官（成人向）、性感动作、情欲场景。**绝不因"露骨""男男""同性性行为"就 reject**。

【必 reject（high）】
1. **CSAM 绝对红线**：疑似未成年人（面相/体型 <18）+ 任何裸露或性暗示——只要触发立即 reject，哪怕不确定也 reject（宁可错杀）
2. **极端暴力/血腥**：严重伤口、肢解、尸体、虐待现场（正常的性癖/BDSM 场景不算）
3. **政治敏感**：中国敏感政治人物面孔、特定旗帜标语、极端组织符号
4. **引流水印**：清晰可见的微信号/QQ/TG/网址二维码水印
5. **赌博/毒品广告**：博彩平台 logo、毒品图片+价格等

【review（medium）】
- 疑似未成年但体型成熟（边界难判）
- 图片中有面孔但模糊无法判断年龄
- 水印看不清但怀疑是联系方式
- 图中似乎有未成年人（如亲子照）+ 无性暗示 → review（保留给人工确认）

【pass（safe）】
- 成年男性裸体、半裸、肌肉、性感自拍
- 成年男男亲密/性行为场景
- 动漫/二次元男同角色（明显成人设定）
- 风景/宠物/食物/艺术等常规头像

【categories 映射】
- csam → porn（reason 标注"疑似未成年"）
- violence → violence
- politics → politics
- ad → ad
- other → other

对成年合法内容，status=pass，categories=[]。
```

---

## 五、comment / nickname / bio × gemini（备用，v3）

Gemini 作为 Grok 熔断时的兜底，prompt 可以较 Grok 版本精简（Gemini 指令遵循稍弱），但核心准则一致：

```
你是成人男同平台内容审核员。合法成人 NSFW 内容 pass。
仅对 CSAM（未成年性化）/ 联系方式引流 / 毒品 / 赌博 / 政治敏感 zero tolerance。
JSON 输出：{status, risk_level, categories, reason}。
```

（每个 biz_type 在此基础上加一句业务上下文即可。）

---

## 发布 checklist

- [ ] comment/grok v3 发布
- [ ] nickname/grok v3 发布
- [ ] bio/grok v3 发布
- [ ] avatar/gemini v3 发布
- [ ] comment/gemini v3 发布
- [ ] nickname/gemini v3 发布
- [ ] bio/gemini v3 发布
- [ ] 回归测试：
  - 合法成人内容（如"想找个 1 一起"、"胸肌照 + 求 tag"）→ pass
  - CSAM 关键词（"17 岁""高中生 + 操"）→ reject
  - 广告引流（"加 VX abc123"）→ reject
  - 政治敏感 → reject
  - 脏话泛用（"卧槽真爽"）→ pass
- [ ] Admin UI Stats 观测 pass_rate 是否从 45% 上升到合理范围
- [ ] 回放（replay）历史 reject 记录，统计误伤率

---

## 实施方式选项

### A. 手动 Admin API 发布（推荐，可审阅每次发布）

```bash
#!/usr/bin/env bash
BASE=https://aicenter-api.1.gay
ADMIN=$PROD_ADMIN_TOKEN

for pair in "comment grok" "nickname grok" "bio grok" "avatar gemini" \
            "comment gemini" "nickname gemini" "bio gemini"; do
  read -r BIZ PROV <<< "$pair"
  FILE="prompts-v3/${BIZ}-${PROV}.md"
  [[ -f "$FILE" ]] || continue
  CONTENT=$(cat "$FILE")
  node -e "console.log(JSON.stringify({
    biz_type: '$BIZ', provider: '$PROV',
    content: require('fs').readFileSync('$FILE','utf8'),
    created_by: 'adult-platform-v3'
  }))" > /tmp/payload.json
  curl -X POST "$BASE/admin/prompts" \
    -H "authorization: Bearer $ADMIN" \
    -H "content-type: application/json" \
    --data-binary @/tmp/payload.json
done
```

### B. Migration 0005 一次性写入（原子、可回滚）

优点：通过 git 控制；缺点：需要先 wrangler secret 里暴露 prompt 内容到 SQL。

推荐 A（手动发布），因为：
- Admin UI 的 dry-run 可以先测试
- 发布后可通过 UI 回滚到 v2
