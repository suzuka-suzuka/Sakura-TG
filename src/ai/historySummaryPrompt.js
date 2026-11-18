/**
 * Default instruction for compressing old roleplay rounds. It is sent as the
 * final user message after the rounds being compressed, while the system
 * prompt stays exactly the one the conversation already uses.
 */
export const DEFAULT_HISTORY_SUMMARY_PROMPT = `[系统指令：压缩剧情记忆]
暂停角色扮演。这条消息不是剧情的一部分，不要续写，也不要以角色身份回应。
请把系统提示词里的「前情提要」（如果有）和上面的全部对话合并，压缩成一份新的前情提要，供之后继续扮演时回顾。

要求：
1. 按时间顺序记录关键剧情、事件因果、重要对话的要点、约定与承诺、伏笔，以及人物关系和情感的变化。
2. 写清当前状态：时间、地点、在场人物、衣着与随身物品、正在进行的事。
3. 保留用户角色自述的设定、经历和偏好。
4. 删去寒暄和重复内容，不评价，不添加新情节。
5. 用第三人称客观叙述，控制在 1500 字以内。
6. 只输出前情提要正文，不要输出 <draw> 标签、标题或任何解释。`;

/** System-prompt section that carries the stored summary into each turn. */
export function formatHistorySummarySection(summary) {
  const text = String(summary || "").trim();
  if (!text) return "";
  return [
    "[前情提要]",
    "以下是更早剧情的压缩记录，之后的对话紧接其后发生。请据此保持剧情和人物状态连贯，不要复述这段内容。",
    text,
  ].join("\n");
}
