/**
 * 设备磨损与维修测试：node test/maintenance.test.js
 * 覆盖：磨损积累/故障自动开工单 → 按优先级从物流预留备件 → 停机检修恢复 →
 *       取消/拆除返还未用备件 → 升级衔接（新机归零、旧单撤销返还）→
 *       与施工统一争料（高优先级工单先取）→ 调度剔除故障机 → 存档续修/旧档兼容
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/contracts.js', 'js/game/maintenance.js',
  'js/game/sim.js', 'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js',
  'js/game/blueprint.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }
function chestCount(b, type) { const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }

function mkGen() {
  const w = 60, h = 40;
  return {
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
    terrain: Array.from({ length: h }, () => Array(w).fill('grass')),
    ores: Array.from({ length: h }, () => Array(w).fill(null)),
    water: new Set(), oil: new Set(),
  };
}

const game = new FG.Game();
game.startWithMap(mkGen(), null, 'maint-test');
const m = game.map, sim = game.sim, mt = game.maintenance;

function P(t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); m.register(b); sim.register(b); return b; }
function stockChest(x, y, items) {
  const c = P('chest', x, y);
  for (const k of Object.keys(items)) sim.chestAdd(c, k, items[k]);
  return c;
}
/** 独立游戏场景（统一料池盘点全图箱子，多工单/料权测试须隔离，避免历史余料串扰） */
function newGameCtx(name) {
  const g = new FG.Game();
  g.startWithMap(mkGen(), null, name || 'ctx');
  const mm = g.map, ss = g.sim;
  return {
    g, mm, ss, mt: g.maintenance,
    P(t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); mm.register(b); ss.register(b); return b; },
    chest(x, y, items) {
      const c = FG.Map.create('chest', x, y); mm.register(c); ss.register(c);
      for (const k of Object.keys(items || {})) ss.chestAdd(c, k, items[k]);
      return c;
    },
  };
}
/** 强制设备立即磨损故障并开工单（绕过寿命） */
function forceBreak(b) { return mt.breakdown(b); }

console.log('\n[1] 磨损配置：可磨损建筑口径 / 寿命 / 备件');
{
  ok(FG.Maintenance.wears(P('furnace', 3, 3)) && FG.Maintenance.wears(P('miner', 4, 3)), '熔炉、矿机计入磨损');
  ok(!FG.Maintenance.wears(P('lab', 5, 3)), '实验室不计磨损');
  ok(!FG.Maintenance.wears(P('belt', 6, 3)) && !FG.Maintenance.wears(P('chest', 7, 3))
    && !FG.Maintenance.wears(P('inserter', 8, 3)), '传送带/箱子/机械臂不计磨损');
  ok(FG.Maintenance.wears(P('assembler', 9, 3)) && FG.Maintenance.wears(P('chemPlant', 10, 3))
    && !FG.Maintenance.wears(P('pump', 12, 3)) && !FG.Maintenance.wears(P('pumpjack', 13, 3)),
    '组装机/化工厂计入磨损；水泵/抽油机（流体生产）不计磨损');
  const fur = m.buildingAt(3, 3), min = m.buildingAt(4, 3);
  ok(mt.lifeOf(fur) === FG.Maintenance.WEAR_LIFE.furnace, '寿命表按类型取');
  ok(mt.partsOf(fur).stone === 3 && mt.partsOf(min).gear === 1 && mt.partsOf(min).ironPlate === 2,
    '备件表：石炉石料、矿机齿轮+铁板');
  // 清掉测试用建筑（避免后续干扰）
  for (const [x, y] of [[3,3],[4,3],[5,3],[6,3],[7,3],[8,3],[9,3],[10,3],[12,3],[13,3]]) {
    const b = m.buildingAt(x, y); if (b) { sim.unregister(b); m.unregister(b); }
  }
}

console.log('\n[2] accrue：随运转积累磨损，到寿命故障并自动生成普通优先级工单');
{
  const g2 = new FG.Game();
  g2.startWithMap(mkGen(), null, 'accrue');
  const fur = FG.Map.create('furnace', 10, 10); fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  g2.map.register(fur); g2.sim.register(fur);
  const life = g2.maintenance.lifeOf(fur);
  ok(g2.maintenance.accrue(fur, 1) === false && fur.wear === 1 && !fur.broken, '未到寿命：累加磨损不故障');
  // 直接累加到寿命-1
  g2.maintenance.accrue(fur, life - 2);
  ok(fur.wear === life - 1 && !fur.broken && g2.maintenance.orders.length === 0, '寿命前一刻仍正常、无工单');
  const broke = g2.maintenance.accrue(fur, 1);
  ok(broke === true && fur.broken && fur.status === 'broken', '到达寿命：故障停机');
  ok(g2.maintenance.orders.length === 1, '自动生成 1 张维修工单');
  const o = g2.maintenance.orders[0];
  ok(o.x === 10 && o.y === 10 && o.type === 'furnace' && o.priority === 'normal'
    && o.repairTimer === 0 && Object.keys(o.stock).length === 0, '工单记录坐标/型号/普通优先级/空预留');
  // 幂等：已故障不再累加、不重复开工单
  ok(g2.maintenance.accrue(fur, 100) === false && g2.maintenance.orders.length === 1, '故障后不再积累磨损、不重复开工单');
  // 非磨损建筑 accrue 无效
  const ch = FG.Map.create('chest', 11, 10);
  ok(g2.maintenance.accrue(ch, 999) === false && !ch.broken, '箱子不磨损');
}

console.log('\n[3] 生产链路：故障机停机不生产、调度器剔除（在途预留语义）');
{
  const g2 = new FG.Game();
  g2.startWithMap(mkGen(), null, 'chain');
  const fur = FG.Map.create('furnace', 10, 10); fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.inputs.ironOre.count = 10;
  g2.map.register(fur); g2.sim.register(fur);
  g2.sim.scheduler.rebuild(0);
  ok(!!g2.sim.scheduler.consumerByKey.get(FG.Utils.key(10, 10)), '正常熔炉是调度消费者');
  forceBreak(fur);
  g2.sim.scheduler.rebuild(1);
  ok(!g2.sim.scheduler.consumerByKey.get(FG.Utils.key(10, 10)), '故障后不再是消费者（不再要料）');
  const crafted0 = fur.totalCrafted;
  ticks(g2, 30);
  ok(fur.status === 'broken' && fur.totalCrafted === crafted0 && fur.slots.inputs.ironOre.count === 10,
    '故障停机：不生产、不耗料、状态保持 broken');
  // 矿机同样停机
  g2.map.ores[12][12] = { type: 'ironOre', amount: 9999 };
  const min = FG.Map.create('miner', 12, 12);
  g2.map.register(min); g2.sim.register(min);
  forceBreak(min);
  ticks(g2, 30);
  ok(min.status === 'broken' && min.progress === 0
    && (!min.slots.outputs.ironOre || min.slots.outputs.ironOre.count === 0), '故障矿机停止开采');
}

console.log('\n[4] 备件预留：从箱子物理取出（移出物流），缺料等待，补齐后续修恢复');
{
  const ctx = newGameCtx('parts'); const { g, mm, ss, mt: M } = ctx;
  const fur = ctx.P('furnace', 20, 20); fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  const ch = ctx.chest(21, 20, { stone: 2 });   // 石炉需石料 3，先只放 2
  M.breakdown(fur);
  const o = M.orderAt(20, 20);
  ok(!!o, '故障开工单');
  g.tickOnce();
  ok((o.stock.stone || 0) === 2 && chestCount(ch, 'stone') === 0 && o.waiting === true,
    '预留 2 石料（物理移出箱子），仍缺 1 → 缺料等待');
  ok(mm.buildingAt(20, 20).broken, '备件不齐：保持故障停机');
  ss.chestAdd(ch, 'stone', 5);
  g.tickOnce();
  ok((o.stock.stone || 0) === 0 && o.repairTimer === FG.Config.MAINT_REPAIR_TICKS,
    '补齐备件：凑齐后消耗预留进入检修倒计时');
  ok(chestCount(ch, 'stone') === 4, '共消耗石料 3（先前2+本次1），余 4');
  ok(mm.buildingAt(20, 20).status === 'repairing' && mm.buildingAt(20, 20).broken, '检修中：设备仍停机，状态 repairing');
  // 检修倒计时期间不再取料
  ticks(g, FG.Config.MAINT_REPAIR_TICKS - 2);
  ok(M.orderAt(20, 20), '检修未结束：工单仍在');
  ticks(g, 2);
  ok(!M.orderAt(20, 20) && M.orders.filter(x => x.x === 20).length === 0, '检修完成：工单出列');
  const fur2 = mm.buildingAt(20, 20);
  ok(!fur2.broken && fur2.wear === 0 && fur2.status !== 'broken' && fur2.status !== 'repairing',
    '设备解除故障、磨损归零、恢复生产');
  // 恢复后能继续生产（喂料）
  fur2.slots.inputs.ironOre.count = 5;
  const c0 = fur2.totalCrafted;
  ticks(g, 25);
  ok(fur2.totalCrafted > c0, '恢复后续产（冶炼次数增加）');
}

console.log('\n[5] 优先级分层 + 同级轮转：高优先级工单先取料');
{
  const ctx = newGameCtx('prio'); const { g, mm, ss, mt: M } = ctx;
  // 两台故障机：石炉A(需石3,高优先) 与 石炉B(需石3,普通)；箱中只有 3 石料
  const fa = ctx.P('furnace', 30, 20); const fb = ctx.P('furnace', 31, 20);
  const ch = ctx.chest(32, 20, { stone: 3 });
  M.breakdown(fa); M.breakdown(fb);
  const oa = M.orderAt(30, 20), ob = M.orderAt(31, 20);
  M.setPriority(oa.id, 'high');
  g.tickOnce();
  // 3 石料只够一台：高优先工单同 tick 取齐并消耗进入检修（stock 已清空、repairTimer 起算），
  // 普通工单一件取不到、缺料等待
  ok(oa.repairTimer === FG.Config.MAINT_REPAIR_TICKS && Object.keys(oa.stock).length === 0
    && (ob.stock.stone || 0) === 0 && chestCount(ch, 'stone') === 0,
    '高优先级工单独占 3 石料并立即进入检修，普通工单 0 件（高层未取料前低层不分配）');
  ok(ob.waiting === true && mm.buildingAt(31, 20).broken, '普通工单缺料等待、设备保持停机');
  // 高优先工单检修完成出列后，补料给普通工单
  ticks(g, FG.Config.MAINT_REPAIR_TICKS + 1);
  ok(!M.orderAt(30, 20) && !mm.buildingAt(30, 20).broken, '高优先工单检修完成');
  ss.chestAdd(ch, 'stone', 3);
  ticks(g, FG.Config.MAINT_REPAIR_TICKS + 2);
  ok(!M.orderAt(31, 20) && !mm.buildingAt(31, 20).broken, '补料后普通工单也检修完成');
}

console.log('\n[6] 取消工单：返还未用预留备件，故障机保持故障');
{
  const ctx = newGameCtx('cancel'); const { g, mm, ss, mt: M } = ctx;
  const fur = ctx.P('furnace', 40, 20);
  // 石炉只需石料：只放 2（缺 1）→ 工单停留在「部分预留」，stock 保留 2 石料待取消返还
  const ch = ctx.chest(41, 20, { stone: 2 });
  M.breakdown(fur);
  const o = M.orderAt(40, 20);
  g.tickOnce();
  ok((o.stock.stone || 0) === 2 && chestCount(ch, 'stone') === 0, '已预留 2 石料（缺 1，部分预留）');
  ok(mm.buildingAt(40, 20).broken, '备件不齐：设备保持故障');
  ok(M.cancel(o.id), '取消工单');
  ok(chestCount(ch, 'stone') === 2 && M.orderAt(40, 20) === null, '取消后未用备件返还箱子，工单移除');
  ok(mm.buildingAt(40, 20).broken, '设备仍处故障态（取消只返还备件，不修理）');
  // 重新走一个 tick：故障机补建工单（续修入口）；当 tick 会立即把返还的 2 石料重新预留
  g.tickOnce();
  const o2 = M.orderAt(40, 20);
  ok(!!o2 && (o2.stock.stone || 0) === 2 && chestCount(ch, 'stone') === 0,
    '下一 tick 为故障机补建新工单并重新预留返还的 2 石料（可继续备料续修）');
  // 清场：补齐修好
  ss.chestAdd(ch, 'stone', 5);
  ticks(g, FG.Config.MAINT_REPAIR_TICKS + 2);
  ok(!mm.buildingAt(40, 20).broken, '补料后新工单检修完成');
}

console.log('\n[7] 拆除故障机：撤销工单并返还未用备件到该格地面堆');
{
  const ctx = newGameCtx('remove'); const { g, mm, mt: M } = ctx;
  const fur = ctx.P('furnace', 42, 22);
  // 只放 2 石料（需 3）→ 工单停留部分预留，stock 持有 2 石料供拆除返还验证
  const ch = ctx.chest(43, 22, { stone: 2 });
  M.breakdown(fur);
  g.tickOnce();
  const o = M.orderAt(42, 22);
  ok((o.stock.stone || 0) === 2 && chestCount(ch, 'stone') === 0, '已预留 2 石料（部分预留）');
  ok(g.removeBuilding(fur), '拆除故障机');
  ok(M.orderAt(42, 22) === null && M.orders.every(x => !(x.x === 42 && x.y === 22)), '工单撤销');
  // 返还：箱子优先（有空位）回箱；验证物料不丢：箱子增量 + 地面堆 = 2
  const pile = mm.pileAt(42, 22);
  const pileStone = pile ? (pile.find(s => s.type === 'stone') || {}).count || 0 : 0;
  ok(chestCount(ch, 'stone') + pileStone === 2, '未用备件 2 件全部返还（箱子优先，余下落地，共 2，实际 箱'
    + chestCount(ch, 'stone') + ' + 地' + pileStone + '）');
}

console.log('\n[8] 升级衔接：新机磨损归零/非故障，旧工单撤销并返还备件');
{
  // 独立游戏，避免共享场景历史箱子里的余料让工单瞬间凑齐
  const g8 = new FG.Game();
  g8.startWithMap(mkGen(), null, 'upgrade-link');
  g8.research.completed.add('steelSmelting');
  const m8 = g8.map, s8 = g8.sim, mt8 = g8.maintenance;
  const Q = (t, x, y, d) => { const b = FG.Map.create(t, x, y, d || 0); m8.register(b); s8.register(b); return b; };
  const fur = Q('furnace', 46, 20);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.outputs.ironPlate.count = 2;
  // 只放 2 石料（需 3）→ 工单停留部分预留，便于验证升级时返还未用备件
  const ch = Q('chest', 47, 20);
  s8.chestAdd(ch, 'stone', 2); s8.chestAdd(ch, 'steelPlate', 4);
  mt8.breakdown(fur);
  g8.tickOnce();
  const o = mt8.orderAt(46, 20);
  // 石炉工单部分预留石料 2（钢炉备件是石3+钢2，但工单按故障时的石炉型号取料）
  ok((o.stock.stone || 0) === 2 && fur.broken, '石炉故障工单部分预留石料 2');

  // 直接走升级替换（swapEntry），验证 onUpgraded 衔接
  const nb = g8.construction.swapEntry({ from: 'furnace', type: 'steelFurnace', x: 46, y: 20 });
  ok(nb && nb.type === 'steelFurnace', '升级为钢炉');
  ok(nb.wear === 0 && !nb.broken && nb.status !== 'broken' && nb.status !== 'repairing',
    '新机磨损归零、解除故障');
  ok(nb.recipe === 'smelt:iron' && nb.slots.outputs.ironPlate.count === 2, '升级仍保留配方/库存');
  ok(mt8.orderAt(46, 20) === null, '旧维修工单已撤销');
  const pile = m8.pileAt(46, 20);
  const pileStone = pile ? (pile.find(s => s.type === 'stone') || {}).count || 0 : 0;
  ok(chestCount(ch, 'stone') + pileStone === 2, '旧工单未用石料 2 返还物流（箱'
    + chestCount(ch, 'stone') + ' + 地' + pileStone + '）');

  // 正常（未故障）设备升级：磨损也归零，不产生工单
  const fur2 = Q('furnace', 48, 20);
  fur2.wear = 123;
  g8.construction.swapEntry({ from: 'furnace', type: 'steelFurnace', x: 48, y: 20 });
  const nb2 = m8.buildingAt(48, 20);
  ok(nb2.type === 'steelFurnace' && nb2.wear === 0 && !nb2.broken, '未故障设备升级同样把磨损归零');
}

console.log('\n[9] 维修与施工统一料权：同池预留，互相盘点不到对方已预留料');
{
  const g2 = new FG.Game();
  g2.startWithMap(mkGen(), null, 'unified');
  g2.research.completed.add('steelSmelting');
  const mm = g2.map, ss = g2.sim;
  const Q = (t, x, y, d) => { const b = FG.Map.create(t, x, y, d || 0); mm.register(b); ss.register(b); return b; };
  // 箱中仅 5 石料
  const ch = Q('chest', 2, 2);
  ss.chestAdd(ch, 'stone', 5);
  // 故障石炉（高优先工单，需石3）
  const fur = Q('furnace', 5, 5);
  g2.maintenance.breakdown(fur);
  g2.maintenance.orders[0].priority = 'high';
  // 同时提交一个需石料的建造计划（用蓝图：石炉造价石5）
  const bp = { w: 1, h: 1, entries: [{ type: 'furnace', dx: 0, dy: 0, dir: 0 }] };
  g2.construction.addPlan(bp, 6, 5);
  g2.construction.plans[0].priority = 'normal';
  g2.tickOnce();
  const wo = g2.maintenance.orders[0];
  const plan = g2.construction.plans[0];
  const planStock = plan.entries[0].stock.stone || 0;
  // 维修先于施工取料（tickOnce 中 maintenance.tick 在 construction.tick 之前）：
  // 高优先维修同 tick 取齐 3 石料并消耗进入检修；施工本 tick 只盘点到剩余 2（不足 5 → 部分预留）
  ok(wo.repairTimer === FG.Config.MAINT_REPAIR_TICKS && Object.keys(wo.stock).length === 0,
    '高优先维修独占 3 石料并进入检修（统一料池、维修先于施工分料）');
  ok(planStock === 2 && chestCount(ch, 'stone') === 0,
    '施工计划当轮仅取到维修剩下的 2 石料（不足 5 部分预留），箱子清空');
  // 维修检修完成后，施工仍缺 3 石料等待
  ticks(g2, FG.Config.MAINT_REPAIR_TICKS + 2);
  ok(!mm.buildingAt(5, 5).broken && g2.maintenance.orders.length === 0, '维修完成、设备修复');
  ok(g2.construction.plans.length === 1 && (g2.construction.plans[0].entries[0].stock.stone || 0) === 2,
    '施工计划仍只预留 2 石料、缺料等待（未凭空多占维修备件）');
  g2.construction.cancel(g2.construction.plans[0].id);
}

console.log('\n[9b] 维修与施工同料竞争：高优先施工 vs 普通维修（分层语义复用同一池）');
{
  const g2 = new FG.Game();
  g2.startWithMap(mkGen(), null, 'unified2');
  const mm = g2.map, ss = g2.sim;
  const Q = (t, x, y, d) => { const b = FG.Map.create(t, x, y, d || 0); mm.register(b); ss.register(b); return b; };
  const ch = Q('chest', 2, 2);
  ss.chestAdd(ch, 'stone', 3);
  const fur = Q('furnace', 5, 5);
  g2.maintenance.breakdown(fur);
  g2.maintenance.orders[0].priority = 'high';
  // 高优先施工计划与高优先维修同档：维修 tick 先取料（同档按各管理器内部轮转）
  const bp = { w: 1, h: 1, entries: [{ type: 'furnace', dx: 0, dy: 0, dir: 0 }] };
  g2.construction.addPlan(bp, 6, 5);
  g2.construction.plans[0].priority = 'high';
  g2.tickOnce();
  ok(g2.maintenance.orders[0].repairTimer === FG.Config.MAINT_REPAIR_TICKS
    && (g2.construction.plans[0].entries[0].stock.stone || 0) === 0,
    '同档高优先：维修先于施工取齐备件进入检修，施工当轮无料');
  g2.construction.cancel(g2.construction.plans[0].id);
}

console.log('\n[10] 存档续修：工单/预留/检修倒计时与 wear/broken 随档恢复');
{
  const g1 = new FG.Game();
  g1.startWithMap(mkGen(), null, 'save');
  const m1 = g1.map, s1 = g1.sim;
  const ch = (() => { const c = FG.Map.create('chest', 1, 1); m1.register(c); s1.register(c); return c; })();
  s1.chestAdd(ch, 'stone', 2);   // 只够 2，工单处于缺料等待
  const fur = FG.Map.create('furnace', 7, 7); fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  m1.register(fur); s1.register(fur);
  g1.maintenance.breakdown(fur);
  g1.maintenance.orders[0].priority = 'high';
  ticks(g1, 2);
  const o = g1.maintenance.orders[0];
  ok((o.stock.stone || 0) === 2 && fur.broken, '存档前：工单已预留 2 石料、缺料等待');
  const data = JSON.parse(JSON.stringify(g1.serialize()));
  ok(data.maintenance.orders.length === 1 && data.maintenance.orders[0].stock.stone === 2
    && data.maintenance.orders[0].priority === 'high', '存档含维修工单与预留/优先级');
  const sb = data.buildings.find(b => b.x === 7 && b.y === 7);
  ok(sb.broken === true && sb.wear > 0, '建筑 broken/wear 随档保存');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const o2 = g2.maintenance.orders[0];
  const fur2 = g2.map.buildingAt(7, 7);
  ok(o2 && o2.priority === 'high' && (o2.stock.stone || 0) === 2 && fur2.broken,
    '读档后工单/预留/优先级与设备故障态恢复');
  // 预留料不在箱子（已移出物流）
  const ch2 = g2.map.buildingAt(1, 1);
  ok(chestCount(ch2, 'stone') === 0, '读档后已预留石料不回流箱子');
  // 补料续修
  g2.sim.chestAdd(ch2, 'stone', 5);
  ticks(g2, FG.Config.MAINT_REPAIR_TICKS + 2);
  ok(!g2.map.buildingAt(7, 7).broken && g2.maintenance.orders.length === 0, '读档后续修：补齐备件、检修完成');
  ok(g2.map.buildingAt(7, 7).wear === 0, '修复后磨损归零');
}

console.log('\n[11] 旧存档兼容：无 maintenance 字段回退空工单；故障机补单、孤儿工单释放');
{
  const g1 = new FG.Game();
  g1.startWithMap(mkGen(), null, 'legacy');
  const fur = FG.Map.create('furnace', 8, 8);
  g1.map.register(fur); g1.sim.register(fur);
  fur.broken = true; fur.wear = 999; fur.status = 'broken';
  const data = JSON.parse(JSON.stringify(g1.serialize()));
  delete data.maintenance;

  const g2 = new FG.Game();
  let err = null;
  try { g2.deserialize(data); ticks(g2, 1); } catch (e) { err = e; }
  ok(!err, '无 maintenance 字段旧档读取不报错' + (err ? '：' + err.stack : ''));
  const fur2 = g2.map.buildingAt(8, 8);
  ok(fur2.broken && g2.maintenance.orders.length === 1, '旧档故障机读入后补建维修工单（可续修）');

  // 孤儿工单：工单指向的建筑已不在档内 → 首个 tick 撤销（无预留则无物料影响）
  const g3 = new FG.Game();
  g3.startWithMap(mkGen(), null, 'orphan');
  const data3 = JSON.parse(JSON.stringify(g3.serialize()));
  data3.maintenance = {
    seq: 5,
    orders: [{ id: 'W9', x: 50, y: 50, type: 'furnace', priority: 'high', stock: {}, repairTimer: 0 }],
  };
  err = null;
  try { g3.deserialize(data3); ticks(g3, 1); } catch (e) { err = e; }
  ok(!err && g3.maintenance.orders.length === 0, '孤儿工单（建筑不存在）首 tick 撤销');
}

console.log('\n[12] 检修倒计时随档恢复：检修中读档后继续计时完成');
{
  const g1 = new FG.Game();
  g1.startWithMap(mkGen(), null, 'repairing-save');
  const fur = FG.Map.create('assembler', 9, 9); fur.recipe = 'craft:gear'; FG.Map.syncRecipeSlots(fur);
  g1.map.register(fur); g1.sim.register(fur);
  const ch = FG.Map.create('chest', 0, 0); g1.map.register(ch); g1.sim.register(ch);
  g1.sim.chestAdd(ch, 'gear', 10); g1.sim.chestAdd(ch, 'ironPlate', 10);
  g1.maintenance.breakdown(fur);
  ticks(g1, 2);   // 备件凑齐进入检修
  const o = g1.maintenance.orders[0];
  ok(o.repairTimer > 0, '存档前处于检修中');
  const half = o.repairTimer;
  ticks(g1, Math.floor(half / 2));
  const data = JSON.parse(JSON.stringify(g1.serialize()));
  const g2 = new FG.Game();
  g2.deserialize(data);
  const o2 = g2.maintenance.orders[0];
  ok(o2 && o2.repairTimer > 0, '读档后仍在检修倒计时（剩余 ' + o2.repairTimer + ' tick）');
  ticks(g2, o2.repairTimer + 1);
  const fur2 = g2.map.buildingAt(9, 9);
  ok(!fur2.broken && g2.maintenance.orders.length === 0, '读档后检修倒计时走完，设备恢复');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
