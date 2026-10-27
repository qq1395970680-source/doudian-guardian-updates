// Prechecks fill an unsubmitted form only. Full journal proof and fresh stop
// acknowledgements are still required before terminating any owned process.
const stages=new Set(['读取全店活动列表','核对当前活动','优先核对风险活动','补读完整历史','全店当前活动核对完成','当前活动仍有读取失败，暂停恢复','尚未连接','读取当前完整规格','批量读取当前完整规格']);
export const isReadonlyStage=stage=>stages.has(stage);
