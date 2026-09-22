export const RESEARCH_PPT_PIPELINE_VERSION = '2026-09-22.1';

const HEADER = `# 科研 PPT 生产流程（用户确认版）

本流程用于基于论文、学位论文、已有 PPT、实验/数值结果和补充推导制作科研汇报。冲突时以用户最新明确要求和已经实际落地的规则为准。`;

const SECTIONS = {
  intake_mode: `## 1–2. 项目初始化与生产模式

1. 项目初始化与资料接收
- 明确汇报用途、听众、时长、语言、正式页与 backup 页需求。
- 接收论文/博论、已有 PPT、数据、实验图、DNS/CFD/PIV 图、推导和旧汇报等 source。
- 用户不需要提前设计整套页序。

2. 先确定生产模式
- Mode A — Imagegen-assisted / 快速交流版：适合组会、内部交流、临时汇报。最终 PPT 允许直接保留 Imagegen 页面或元素。最终哪些位置替换成真图，由用户在整套审核时决定。GPT 仍应尽可能寻找合适真图供 Imagegen 参考。
- Mode B — Zero-Imagegen Final / 正式版：适合中期、预答辩、正式答辩等。Imagegen 可以用于视觉探索，但最终成品不得保留任何 Imagegen 像素或生成元素；文字、公式、框线、箭头、示意结构等均以 PowerPoint 原生对象或代码/真实素材重构。`,

  visual_calibration: `## 3. 视觉风格与信息密度校准

- 在整套正式生产前，先与用户对齐版式风格、正式程度、信息密度、标题区、主体区、结论区、页脚、图文比例和留白。
- 先做 1–3 张代表性视觉参考页反复调整，直到用户确认整套的视觉基准。
- 固定的是 master language、上下母版锚点和密度范围；中间主体不应被锁死成统一左右栏或固定网格。
- 具体比例、字号、密度属于项目参数，不应把某个项目的百分比直接写成通用硬规则。`,

  source_assets: `## 4. Source Understanding + 素材工作区准备

- GPT 系统阅读 source，建立科学事实、公式、数据、结论与图表的对应关系，并主动寻找全套可能使用的真实素材。
- 任何准备使用、推荐或提供给 Imagegen 的图片，GPT 必须先实际打开看过；不能只根据文件名、图号、索引或搜索结果判断。
- 大图或大量图片必要时制作轻量预览/contact sheet 再审，不能因为查看困难而跳过。
- “找到图”不等于“应该用图”：低质量、重复、无关或与页面叙事不匹配的素材应淘汰。
- 低分辨率但不可替代的真实证据可以保留，但应限制显示尺寸，避免强行放大。
- 流程图、技术路线图等结构素材可以只保留逻辑，不必机械保留原图。
- 确认后的素材放进 GPT 自己的项目工作区。工作区目录结构不固定，由 GPT 根据项目和工具环境自行决定最方便的组织方式；可按页、章节、素材类型、状态或其他方式组织。
- 唯一硬要求是 GPT 能稳定追踪：哪一页用哪些素材、素材来源、是否已经实际查看和审核。
- Step 4 是内部生产阶段，不在这里给用户发送素材。`,

  deck_design: `## 5. GPT 自主设计整套故事与页序

- GPT 根据 source、汇报目的和时间自主决定正式页数、backup 页、页序、章节节奏、每页核心 claim、公式、证据与必要推导页。
- 不要求用户先审批一套逐页文字版 PPT。
- 基本原则是“一页一个主科学信息”，但正式中期/答辩可以保持较高科研信息密度来体现工作量。
- 当系数、特征尺度、闭合关系或力平衡发生关键变化且观众会自然追问“为什么”时，GPT 应主动增加必要推导页，而不是只展示 Original → Present。`,

  slide_specs: `## 6–7. 建立逐页唯一施工稿

6. One slide = one canonical self-contained production spec
- 每页只维护一份 canonical Pxx.md/等价内部施工稿，不再同时维护“施工稿 + 精简 Prompt”两套版本。
- 每份施工稿必须能在一个全新的 Imagegen 会话中独立工作。
- 至少包含：本页科学目的、标题、关键事实、公式/数字、真实参考素材、可自由生成的视觉内容、版式/信息密度要求、底部结论和禁止事项。
- 禁止依赖“沿用上一页”“后面再讲”“参考前页”等上下文。

7. 写清真实素材与生成内容的角色
- 逐页说明哪些是真实科研素材、哪些是 Imagegen 可生成的流程/机制/概念/装饰内容。
- 存在合适真图时，尽可能优先让 Imagegen 参考真图，以提高复原、构图和后续替换的可追溯性。
- Mode A 中允许最终保留 Imagegen 内容，是否换真图留到用户整套审核时决定。
- Mode B 中 Imagegen 仅作为设计参考，最终必须全部重构或替换为真实/原生内容。`,

  self_audit: `## 8. GPT 全套自审后才进入用户生成

- 用户开始生成之前，GPT 必须先完成整套逐页施工稿，并自审到 production-ready。
- 自审至少覆盖：科学正确性、故事连续性、公式/数字、标题与结论、真实图是否实际看过、素材与页面是否匹配、信息密度、母版一致性、自包含性、跨页依赖、缺失素材、孤儿素材、重复/冲突规则、编码和文件组织。
- 需要时多轮审查，并直接修正发现的问题。
- 不把未经全套自审的半成品 prompt 直接交给用户开始批量生成。`,

  handoff: `## 9. 逐页 Handoff：参考图 + 可复制提示词

当用户准备生成某一页时：
1. 从工作区取出已经通过全套自审的该页 canonical production spec。
2. 只选择 Step 4 中已经实际看过并确认适合本页的参考图。
3. 只要本页存在需要用户上传给 Imagegen 的参考图，就必须实际调用 CCM 的文件传输能力（优先 ccm-extra.send_file）逐个把文件发送进当前聊天；不能只回复文件名、路径、目录或“参考图如下”就视为已交付。
4. send_file 返回的聊天内文件/资源才算完成参考图交付。文件名和路径只能作为说明，不能替代实际文件上传。
5. 如果 send_file 失败、路径失效、文件过大或未返回可用资源，GPT 必须先修复/重试或明确说明该参考图尚未成功发送；不得在文件实际未交付时让用户自行去内部工作区查找。
6. 不要求用户去内部工作区找图，也不让用户自己判断应该选哪张。
7. 不把 .md 文件本身作为用户的生成输入附件。
8. 将该页完整、自包含的最终提示词直接在聊天里用独立的 fenced text/code block 给出，方便用户一键复制。
9. 提示词必须是完整版本，不使用“在上一版基础上修改”“沿用前页”等增量指令。
10. 在文本框旁简要注明本页需要上传哪些已通过 send_file 实际发送的参考图；不需要参考图时明确说明无需上传。
11. 用户实际操作：新开 Imagegen 会话 → 上传 GPT 在当前聊天中实际发送的该页参考图 → 复制文本框里的完整提示词 → 粘贴并生成。`,

  generation_review: `## 10–12. Fresh-chat 生成、返图判定、动态升级

10. 用户逐页生成
- One slide = one fresh Imagegen chat，隔离跨页内容和风格污染。
- 每页任务书完整重复必要母版、本页事实与禁忌，不依赖前一个 Imagegen 会话。

11. 用户返图后由 GPT 直接判定是否需要重生成
- 用户发回某页生成图后，GPT 必须先实际查看该图，并对照该页 canonical production spec 判断“需要重生成”还是“可以继续”，不要把这个判断重新丢给用户。
- 优先检查科学硬伤：公式、数字、物理方向、因果、关键图像误读、遗漏关键结论或证据；同时检查会明显影响汇报的可读性、裁切、遮挡、版式失衡和关键信息缺失。
- 普通间距、字号、轻微对齐、装饰差异等非关键问题，默认不作为强制重生成理由，除非已明显影响阅读或违背该页核心设计。
- 若需要重生成：明确指出最少且关键的问题，更新受影响的 canonical production spec，并直接给出该页修正后的完整自包含提示词；若仍需参考图，必须再次按 Step 9 用 ccm-extra.send_file 实际发送所需文件，不得只给文件名。
- 若不需要重生成：不要再要求用户确认“是否继续”或单独回复“这页可以”。应立即进入下一页 Handoff，一次性把下一页需要的参考图通过 ccm-extra.send_file 实际发送，并给出下一页完整提示词和参考资料说明。
- 如果当前已经是最后一页且不需要重生成，则直接进入整套组装 / Global QA 阶段，而不是索要一次额外确认。
- 用户始终可以主动要求返工、跳页或调整标准；最新明确要求优先。

12. Prompt/页面允许动态升级
- 初始必须有完整且自审通过的任务书，但生产过程中发现新问题、增加推导页、素材变化或表达歧义时，只升级受影响页面。
- 最新明确规则覆盖旧规则，不为了“已经定稿”保留已知错误。`,

  assembly: `## 13–14. 按模式组装并做 GPT 全文 QA

13. 整套页面完成后的组装方式
- Mode A：允许直接使用审核后的整页 Imagegen 图快速组装 PPT，也可以局部替换真图；不强制全面可编辑重构。
- Mode B：以 Imagegen 页面为视觉参考完成零 Imagegen 重构。文字、公式、框线、箭头、流程结构使用 PowerPoint 原生对象；科研图插入真实原图；数据图可根据真实数据代码绘制；示意图最终用 PPT 元素重绘并由用户调整。

14. GPT Whole-deck Global QA
- 检查页序、章节节奏、故事闭环、术语、公式/数字一致性、标题/结论位置、视觉密度、图像用途、重复/缺页、插页造成的编号变化。
- Mode B 还必须检查最终是否存在任何 Imagegen 残留。`,

  final_review: `## 15–17. 强制用户全文验收、定向返工、最终交付

15. 用户 Whole-deck Review 是强制验收 Gate
- 整套完成且 GPT Global QA 后，必须要求用户看完整 PPT。
- 用户决定哪些页面接受、哪些返工、哪些 AI 图换真图、哪些页拆分/加强证据、哪些视觉问题可以接受。
- 即使生产过程中完全没有逐页审核，这一步也不能跳过。

16. 定向返工
- 用户全文审核后，只修改有问题的页。
- 需要重生成的页更新 canonical production spec；需要换真图的替换素材；需要推导的补推导；需要重构的重构。
- 除非故事本身发生重大变化，不重新从第一页跑完整流程。

17. 最终交付
- Mode A：presentation-ready 快速版，可含 Imagegen 元素。
- Mode B：正式、零 Imagegen、可编辑 PowerPoint 版本。
- 需要时保留生成参考稿、源图、代码绘图结果、backup 页和逐页施工稿，便于后续维护。`,
};

const ORDER = [
  'intake_mode',
  'visual_calibration',
  'source_assets',
  'deck_design',
  'slide_specs',
  'self_audit',
  'handoff',
  'generation_review',
  'assembly',
  'final_review',
];

function modeNote(mode) {
  if (mode === 'imagegen_assisted') {
    return `\n\n## 当前模式提示：Mode A\n最终允许保留 Imagegen 页面/元素。优先保证交流效率；真图替换范围由用户在整套审核时决定。`;
  }
  if (mode === 'zero_imagegen_final') {
    return `\n\n## 当前模式提示：Mode B\nImagegen 只用于视觉探索。最终交付必须零 Imagegen 残留，并尽可能保持 PowerPoint 原生可编辑。`;
  }
  return '';
}

export function getResearchPptPipeline(section = 'full', mode = 'auto') {
  const normalized = section || 'full';
  const body = normalized === 'full'
    ? ORDER.map((key) => SECTIONS[key]).join('\n\n')
    : SECTIONS[normalized];
  if (!body) throw new Error('Unknown research PPT pipeline section: ' + normalized);
  return `${HEADER}\n\n${body}${modeNote(mode)}`;
}

export const RESEARCH_PPT_PIPELINE_SECTIONS = Object.freeze([...ORDER]);
