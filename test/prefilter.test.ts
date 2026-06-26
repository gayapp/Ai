import { describe, expect, it } from "vitest";
import { applyPrefilter, stripContent, AD_RULES } from "../src/moderation/prefilter.ts";

describe("prefilter · stripContent", () => {
  it("counts significant chars correctly", () => {
    expect(stripContent("hello").significantChars).toBe(5);
    expect(stripContent("你好").significantChars).toBe(2);
    expect(stripContent("   ").significantChars).toBe(0);
  });

  it("detects pure emoji", () => {
    expect(stripContent("😀😀😀").wasEffectivelyEmojiOnly).toBe(true);
    expect(stripContent("😀").wasEffectivelyEmojiOnly).toBe(true);
    expect(stripContent("👨‍👩‍👧‍👦").wasEffectivelyEmojiOnly).toBe(true);
    expect(stripContent("hi 😀").wasEffectivelyEmojiOnly).toBe(false);
  });

  it("detects zero-width characters", () => {
    expect(stripContent("ab​cd").hadZeroWidth).toBe(true);
    expect(stripContent("abcd").hadZeroWidth).toBe(false);
  });
});

describe("prefilter · applyPrefilter L1 (low signal)", () => {
  it("passes pure emoji comments with tag=low_signal", () => {
    const r = applyPrefilter("comment", "😀😀😀");
    expect(r.kind).toBe("pass_lowsignal");
    expect(r.tag).toBe("low_signal");
    expect(r.result?.status).toBe("pass");
  });

  it("passes 1-char comments", () => {
    const r = applyPrefilter("comment", "好");
    expect(r.kind).toBe("pass_lowsignal");
  });

  it("does not short-circuit normal-length comments", () => {
    const r = applyPrefilter("comment", "这个电影真不错");
    expect(r.kind).toBe("skip");
  });

  it("nickname uses strict threshold (only truly empty)", () => {
    // nickname like "好" should NOT be short-circuited (legitimate short name)
    const r = applyPrefilter("nickname", "好");
    expect(r.kind).toBe("skip");
  });

  it("avatar is never pre-filtered by L1/L2", () => {
    const r = applyPrefilter("avatar", "https://picsum.photos/300");
    expect(r.kind).toBe("skip");
  });

  it("post skips L1 low-signal pass (images carry the risk)", () => {
    // emoji/空标题不能因文本短而放行——图片才是风险载体。
    expect(applyPrefilter("post", "😀😀").kind).toBe("skip");
    expect(applyPrefilter("post", "").kind).toBe("skip");
  });

  it("post still runs L2 ad rules on the caption", () => {
    const r = applyPrefilter("post", "看主页 加V abc12345");
    expect(r.kind).toBe("reject_ad");
    expect(r.result?.categories).toEqual(["ad"]);
  });
});

describe("prefilter · applyPrefilter L2 (ad blacklist)", () => {
  it("catches 加V + account", () => {
    const r = applyPrefilter("comment", "加V abc12345");
    expect(r.kind).toBe("reject_ad");
    expect(r.result?.status).toBe("reject");
    expect(r.result?.categories).toEqual(["ad"]);
  });

  it("catches 微信 + id", () => {
    const r = applyPrefilter("comment", "微信号 wangxiaoming");
    expect(r.kind).toBe("reject_ad");
  });

  it("catches 加我的X + account (real-world prod case 019dbbe5)", () => {
    const r = applyPrefilter("comment", "你好加我的X：zhanghao3333");
    expect(r.kind).toBe("reject_ad");
    expect(r.tag).toMatch(/^ad:/);
  });

  it("catches 加推特 + id", () => {
    expect(applyPrefilter("comment", "加推特 gayxx2024").kind).toBe("reject_ad");
  });

  it("catches 私聊VX + id", () => {
    expect(applyPrefilter("comment", "私聊VX abc12345").kind).toBe("reject_ad");
  });

  it("catches QQ number", () => {
    const r = applyPrefilter("nickname", "QQ876543210");
    expect(r.kind).toBe("reject_ad");
    expect(r.tag).toContain("qq_number");
  });

  it("catches CN phone numbers", () => {
    const r = applyPrefilter("comment", "联系 13800138000 马上回");
    expect(r.kind).toBe("reject_ad");
  });

  it("catches QQ written in Chinese numerals (real-world prod case)", () => {
    // 扣 + 中文数字拼出的 QQ 号 3410437489，规避 \d 正则
    const r = applyPrefilter(
      "comment",
      "苏州求大鸡爸爸操死我。扣。三十四亿一千零四十三万七千四百八十九",
    );
    expect(r.kind).toBe("reject_ad");
    expect(r.result?.categories).toEqual(["ad"]);
    expect(r.tag).toContain("cn_numeral_contact");
  });

  it("catches 微信 + Chinese-numeral account", () => {
    expect(
      applyPrefilter("bio", "微信一三八零零一三八零零零").kind,
    ).toBe("reject_ad");
  });

  it("catches Telegram", () => {
    const r = applyPrefilter("bio", "telegram @happyguy2024");
    expect(r.kind).toBe("reject_ad");
  });

  it("catches suspicious TLDs", () => {
    const r = applyPrefilter("comment", "来 https://click.xyz/link 看福利");
    expect(r.kind).toBe("reject_ad");
  });

  it("catches business intent words", () => {
    expect(applyPrefilter("nickname", "VIP门槛99").kind).toBe("reject_ad");
    expect(applyPrefilter("nickname", "专出肉小帅").kind).toBe("reject_ad");
  });

  it("catches external platform lead words", () => {
    expect(applyPrefilter("bio", "推特同名 gayxx").kind).toBe("reject_ad");
    expect(applyPrefilter("bio", "O站同名找我").kind).toBe("reject_ad");
  });

  it("does NOT false-positive on normal adult content", () => {
    expect(applyPrefilter("comment", "刚洗完澡 全裸一张").kind).toBe("skip");
    expect(applyPrefilter("comment", "1 求约 183/75 今晚在家").kind).toBe("skip");
    expect(applyPrefilter("bio", "肌肉熊 183 找长期").kind).toBe("skip");
  });

  it("does NOT false-positive on short Chinese-numeral phrases", () => {
    // 短中文数字串（年份/金额/口语）不应触发 cn_numeral_contact
    expect(applyPrefilter("comment", "二〇二四年加油").kind).toBe("skip");
    expect(applyPrefilter("comment", "千万不要错过").kind).toBe("skip");
    expect(applyPrefilter("comment", "我加了三万块").kind).toBe("skip");
  });
});

describe("prefilter · AD_RULES coverage sanity", () => {
  it("has named rules", () => {
    for (const r of AD_RULES) {
      expect(r.name).toMatch(/^[a-z_]+$/);
      expect(r.re).toBeInstanceOf(RegExp);
    }
  });
});
