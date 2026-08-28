export const activeAiTasks = new Map();
export const aiStopRequests = new Set();

let taskCounter = 0;

export function getStopKey(ctx) {
  const selfId = ctx?.self_id || ctx?.me?.id || "default";
  const userId = ctx?.user_id || ctx?.from?.id || "unknown";
  const groupId = ctx?.group_id;
  return groupId
    ? `bot:${selfId}:group:${groupId}:user:${userId}`
    : `bot:${selfId}:private:${userId}`;
}

export function startAiTask(ctx) {
  const key = getStopKey(ctx);
  const taskId = `ai-task-${Date.now()}-${++taskCounter}`;
  const tasks = activeAiTasks.get(key) || new Set();
  tasks.add(taskId);
  activeAiTasks.set(key, tasks);
  return taskId;
}

export function finishAiTask(ctx, taskId) {
  if (!taskId) return;
  aiStopRequests.delete(taskId);
  const key = getStopKey(ctx);
  const tasks = activeAiTasks.get(key);
  if (!tasks) return;
  tasks.delete(taskId);
  if (tasks.size === 0) activeAiTasks.delete(key);
}

export function requestStopCurrentTasks(ctx) {
  const tasks = activeAiTasks.get(getStopKey(ctx));
  if (!tasks?.size) return false;
  for (const taskId of tasks) aiStopRequests.add(taskId);
  return true;
}

export function checkAndClearStopFlag(taskId) {
  if (!taskId || !aiStopRequests.has(taskId)) return false;
  aiStopRequests.delete(taskId);
  return true;
}
