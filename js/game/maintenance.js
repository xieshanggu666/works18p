/**
 * FG.Maintenance —— 设备磨损与维修管理器
 *
 * 玩法：生产设备（矿机/熔炉/组装机/化工厂/炼油厂，与施工「试产生产建筑」
 * 同一口径 isProducer）随运转积累磨损 wear，达到寿命 life 后故障（broken），
 * 自动生成维修工单；工单按高/中/低优先级，每 tick 从与施工共用的统一自由
 * 物料池（箱子→地面堆）预留备件；备件凑齐后停机检修若干 tick，消耗备件、
 * 清零磨损并恢复生产。
 *
 * 料权模型（与施工/合同同一套语义：预留即移出物流）：
 *  - 工单备件经 FG.Construction.MaterialPool 盘点并物理取出（箱子→地面堆），
 *    预留量记入工单 stock，机械臂/按需调度/施工都盘点不到；
 *  - 高优先级工单未取料前低优先级不分料，同级按轮转游标公平起步；
 *  - 取消工单 / 拆除故障机 / 升级替换新机：未用预留备件经
 *    FG.Construction.refundToLogistics 返还物流（优先箱子，余下落到该格地面堆）。
 *
 * 状态衔接：
 *  - 故障机 b.broken=true：仿真侧跳过其生产（sim 在矿机/配方建筑更新前剔除），
 *    调度器不再视其为消费者（不再要料），其旧配方在途预留下一 tick 由调度器
 *    自动剥离释放；槽位库存保留，检修恢复后续产；
 *  - 原地升级换为新机：新机磨损归零、非故障；旧机若有未完工单则撤销并返还
 *    预留备件（由 Construction.swapEntry 调 onUpgraded）；
 *  - 拆除建筑：removeBuilding 先调 onBuildingRemoved 撤销工单/返还备件，
 *    再走既有物料落地流程；
 *  - 读档：工单与建筑 wear/broken 全部序列化，读档后续修；无 maintenance
 *    字段的旧存档回退空工单（故障机补建工单、孤儿工单释放预留），行为不变。
 */
FG.Maintenance = class Maintenance {
  constructor(game) {
    this.game = game;
    this.orders = [];   // [{id,x,y,priority,stock:{},repairTimer,waiting}]
    this.seq = 1;
    this.tierStart = { high: 0, normal: 0, low: 0 };
  }

  reset() {
    this.orders = [];
    this.seq = 1;
    this.tierStart = { high: 0, normal: 0, low: 0 };
  }

  // ================= 设备磨损配置 =================
  /** 该建筑是否会磨损（矿机 + 配方建筑；实验室/物流/流体生产不计） */
  static wears(b) {
    if (!b) return false;
    if (b.def && b.def.recipeBuilding) return true;
    return b.type === 'miner';
  }

  lifeOf(b) { return WEAR_LIFE[b.type] || FG.Config.MAINT_DEFAULT_LIFE; }
  partsOf(b) { return REPAIR_PARTS[b.type] || {}; }

  /** 磨损比例 0~1（UI 磨损条用） */
  wearFraction(b) {
    if (!FG.Maintenance.wears(b)) return 0;
    return Math.max(0, Math.min(1, (b.wear || 0) / this.lifeOf(b)));
  }

  /** 该建筑当前进行中的维修工单 */
  orderAt(x, y) {
    const k = FG.Utils.key(x, y);
    return this.orders.find(o => o.key === k) || null;
  }

  byId(id) { return this.orders.find(o => o.id === id) || null; }

  // ================= 磨损推进（由 sim 在设备运转时调用） =================
  /**
   * 设备运转一 tick 的磨损记账：累加 wear，达到寿命即故障并自动开工单。
   * 返回是否在本次发生故障（调用方可据此立即停机）。broken/不计磨损的设备跳过。
   */
  accrue(b, amount) {
    if (!FG.Maintenance.wears(b) || b.broken) return false;
    b.wear = (b.wear || 0) + (amount || 1);
    if (b.wear >= this.lifeOf(b)) return this.breakdown(b);
    return false;
  }

  /** 设备故障：置 broken，自动生成普通优先级维修工单 */
  breakdown(b) {
    if (!FG.Maintenance.wears(b)) return false;
    b.broken = true;
    b.wear = this.lifeOf(b);
    b.status = 'broken';
    if (this.orderAt(b.x, b.y)) return true;   // 已有工单（兜底，防重复）
    const order = {
      id: 'W' + (this.seq++),
      key: FG.Utils.key(b.x, b.y),
      x: b.x, y: b.y, type: b.type,
      priority: 'normal',
      stock: {},            // 已从物流预留（移出）的备件
      repairTimer: 0,       // 备件凑齐后的检修倒计时（>0=检修中）
      waiting: false,
    };
    this.orders.push(order);
    this.game.logMsg('⚠ ' + b.def.name + ' (' + b.x + ',' + b.y + ') 已磨损故障、停机：'
      + '已生成维修工单（' + this.partsText(b) + '）', 'error');
    FG.Events.emit('maintenance:change');
    return true;
  }

  // ================= 工单操作（面板） =================
  setPriority(orderId, priority) {
    const o = this.byId(orderId);
    if (!o || !MT_VALID_PRIORITIES[priority]) return false;
    o.priority = priority;
    FG.Events.emit('maintenance:change');
    return true;
  }

  /** 取消工单：返还未用预留备件（故障机保持故障态，可重新开工单） */
  cancel(orderId) {
    const i = this.orders.findIndex(o => o.id === orderId);
    if (i < 0) return false;
    const o = this.orders[i];
    FG.Construction.refundToLogistics(this.game, o.stock, o.x, o.y);
    this.orders.splice(i, 1);
    this.game.logMsg('已取消维修工单「' + o.id + '」：未用备件已返还物流', 'info');
    FG.Events.emit('maintenance:change');
    return true;
  }

  // ================= 主循环：统一备件池 × 优先级分层 × 同级轮转 =================
  tick() {
    // 1. 对账：建筑已拆 → 撤销工单并返还；已修好/不再故障 → 完成出列；
    //    存档读入的 broken 建筑若无工单则补建（续修）
    this.reconcile();
    if (!this.orders.length) return;

    // 2. 状态复位
    for (const o of this.orders) o.waiting = false;

    // 3. 检修中的工单先推进倒计时（备件已在库，不参与本轮分料）
    for (const o of this.orders) {
      if (o.repairTimer > 0) {
        o.repairTimer--;
        if (o.repairTimer <= 0) this.completeOrder(o);
      }
    }
    if (!this.orders.some(o => o.repairTimer <= 0)) return;

    // 4. 统一自由备件池（与施工 MaterialPool 同口径：箱子→地面堆）
    const pool = new FG.Construction.MaterialPool(this.game);
    this.tierStart = { high: 0, normal: 0, low: 0 };

    // 高优先级一层未取料前低层不分配；同级轮转公平起步
    for (const tier of MT_TIERS) {
      const list = this.orders.filter(o => o.priority === tier && o.repairTimer <= 0
        && this.game.map.buildingAt(o.x, o.y));
      if (!list.length) continue;
      const start = this.tierStart[tier] % list.length;
      let progressed = false;
      for (let n = 0; n < list.length; n++) {
        const o = list[(start + n) % list.length];
        if (this.processOrder(o, pool)) progressed = true;
      }
      if (progressed) this.tierStart[tier] = (start + 1) % list.length;
    }
  }

  /** 推进单个工单一轮：尽量预留缺口备件；凑齐则进入停机检修倒计时 */
  processOrder(o, pool) {
    const b = this.game.map.buildingAt(o.x, o.y);
    if (!b || !b.broken) return false;
    const cost = this.partsOf(b);
    let progressed = false;
    for (const item of Object.keys(cost)) {
      const want = cost[item] - (o.stock[item] || 0);
      if (want <= 0) continue;
      const got = pool.take(item, want);   // 预留即物理取出（移出物流）
      if (got > 0) {
        o.stock[item] = (o.stock[item] || 0) + got;
        progressed = true;
      }
    }
    if (this.orderReady(o)) {
      this.consumeAndStartRepair(o);
      progressed = true;
    } else {
      o.waiting = true;   // 缺料等待（UI 状态）
    }
    return progressed;
  }

  /** 工单备件是否已凑齐整套 */
  orderReady(o) {
    const b = this.game.map.buildingAt(o.x, o.y);
    if (!b) return false;
    const cost = this.partsOf(b);
    for (const item of Object.keys(cost)) {
      if ((o.stock[item] || 0) < cost[item]) return false;
    }
    return true;
  }

  /** 消耗预留备件，进入停机检修（倒计时期间设备保持故障停机） */
  consumeAndStartRepair(o) {
    const b = this.game.map.buildingAt(o.x, o.y);
    if (!b) return;
    const cost = this.partsOf(b);
    for (const item of Object.keys(cost)) {
      o.stock[item] -= cost[item];
      if (o.stock[item] <= 0) delete o.stock[item];
    }
    o.repairTimer = FG.Config.MAINT_REPAIR_TICKS;
    o.waiting = false;
    b.status = 'repairing';
    FG.Events.emit('maintenance:change');
  }

  /** 检修完成：设备清零磨损、解除故障、恢复生产，工单出列 */
  completeOrder(o) {
    const i = this.orders.indexOf(o);
    if (i >= 0) this.orders.splice(i, 1);
    const b = this.game.map.buildingAt(o.x, o.y);
    if (b) {
      b.broken = false;
      b.wear = 0;
      b.progress = 0;
      b.status = 'idle';
      this.game.logMsg('🔧 ' + b.def.name + ' (' + o.x + ',' + o.y + ') 检修完成，已恢复生产', 'unlock');
    }
    FG.Events.emit('maintenance:change');
  }

  /** 每 tick 对账（幂等） */
  reconcile() {
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i];
      const b = this.game.map.buildingAt(o.x, o.y);
      if (!b || !FG.Maintenance.wears(b)) {
        // 建筑已拆/被换成不磨损型号：撤销工单、返还备件（拆除时另已单独处理，此处兜底）
        FG.Construction.refundToLogistics(this.game, o.stock, o.x, o.y);
        this.orders.splice(i, 1);
        continue;
      }
      if (!b.broken && o.repairTimer <= 0) {
        // 设备已不故障（异常/外部复位）且未在检修：完成出列并返还残余备件
        FG.Construction.refundToLogistics(this.game, o.stock, o.x, o.y);
        this.orders.splice(i, 1);
      }
    }
    // 故障但无工单（读档续修 / 兜底）：补建工单
    for (const b of this.game.map.buildings.values()) {
      if (b.broken && FG.Maintenance.wears(b) && !this.orderAt(b.x, b.y)) {
        const o = {
          id: 'W' + (this.seq++), key: FG.Utils.key(b.x, b.y), x: b.x, y: b.y, type: b.type,
          priority: 'normal', stock: {}, repairTimer: 0, waiting: false,
        };
        this.orders.push(o);
      }
    }
  }

  // ================= 拆除 / 升级衔接 =================
  /** 建筑被拆除：撤销其工单并返还未用备件（在 removeBuilding 注销前调用） */
  onBuildingRemoved(b) {
    if (!b || !FG.Maintenance.wears(b)) return;
    const o = this.orderAt(b.x, b.y);
    if (!o) return;
    FG.Construction.refundToLogistics(this.game, o.stock, b.x, b.y);
    this.orders.splice(this.orders.indexOf(o), 1);
    this.game.logMsg(b.def.name + ' (' + b.x + ',' + b.y + ') 已拆除：维修工单撤销，未用备件落到地面堆', 'info');
    FG.Events.emit('maintenance:change');
  }

  /**
   * 原地升级换机：新机磨损归零、非故障；旧机若有未完工单则撤销并返还预留备件。
   * 由 Construction.swapEntry 在新建筑落成、地面物料回收之后调用。
   */
  onUpgraded(old, nb) {
    nb.wear = 0;
    nb.broken = false;
    nb.status = nb.status === 'broken' || nb.status === 'repairing' ? 'idle' : nb.status;
    const o = this.orderAt(old.x, old.y);
    if (o) {
      FG.Construction.refundToLogistics(this.game, o.stock, nb.x, nb.y);
      this.orders.splice(this.orders.indexOf(o), 1);
      this.game.logMsg('⬆ ' + nb.def.name + ' (' + nb.x + ',' + nb.y + ') 已升级为新机：磨损归零，'
        + '原维修工单「' + o.id + '」撤销、未用备件返还物流', 'unlock');
      FG.Events.emit('maintenance:change');
    }
  }

  /** 备件需求文案（日志用） */
  partsText(b) {
    const cost = this.partsOf(b);
    return Object.keys(cost).map(k => FG.Items.byId(k).name + '×' + cost[k]).join('、') || '免备件';
  }

  // ================= 存档 =================
  serialize() {
    return {
      seq: this.seq,
      orders: this.orders.map(o => ({
        id: o.id, x: o.x, y: o.y, type: o.type, priority: o.priority,
        stock: Object.assign({}, o.stock), repairTimer: o.repairTimer || 0,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.seq = data.seq || 1;
    for (const so of (data.orders || [])) {
      this.orders.push({
        id: so.id || ('W' + (this.seq++)),
        key: FG.Utils.key(so.x, so.y),
        x: so.x, y: so.y, type: so.type || null,
        priority: MT_VALID_PRIORITIES[so.priority] ? so.priority : 'normal',
        stock: so.stock && typeof so.stock === 'object' ? so.stock : {},
        repairTimer: so.repairTimer || 0,
        waiting: false,
      });
    }
    // 孤儿工单（建筑已不在/不再故障）在首个 tick 由 reconcile 释放预留；
    // 故障但无工单的建筑补建工单 —— 读档后续修。建筑 wear/broken 随建筑档恢复。
  }
};

const MT_TIERS = ['high', 'normal', 'low'];
const MT_VALID_PRIORITIES = { high: 1, normal: 1, low: 1 };

/**
 * 设备磨损寿命（tick，20 tick=1 秒）：按建筑类型配置，未配置用 MAINT_DEFAULT_LIFE。
 * 高级型号寿命更长（升级换机即获得更长无故障运行时间）。取 4 分钟以上：磨损是
 * 持续运转后的渐进负担（玩家有时间铺设备件物流），而非开局即频繁停机。
 */
const WEAR_LIFE = {
  furnace: 4800,       // 石炉（4 仿真分钟）
  steelFurnace: 9600,  // 钢炉（8 分钟）
  assembler: 6000,     // 组装机（5 分钟）
  assembler2: 12000,   // 二级组装机（10 分钟）
  chemPlant: 7200,     // 化工厂（6 分钟）
  refinery: 7200,      // 炼油厂（6 分钟）
  miner: 4800,         // 矿机（4 分钟）
};

/** 维修备件成本（复用既有零件，不新增物品）：{ 建筑类型: { item: n } } */
const REPAIR_PARTS = {
  furnace: { stone: 3 },
  steelFurnace: { stone: 3, steelPlate: 2 },
  assembler: { gear: 2, ironPlate: 2 },
  assembler2: { gear: 2, circuit: 2 },
  chemPlant: { circuit: 2, ironBeam: 1 },
  refinery: { ironBeam: 2, gear: 1 },
  miner: { gear: 1, ironPlate: 2 },
};

// 配置表对外只读暴露（测试 / UI 查阅）
FG.Maintenance.WEAR_LIFE = WEAR_LIFE;
FG.Maintenance.REPAIR_PARTS = REPAIR_PARTS;
