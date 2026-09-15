/**
 * 设备在位状态的"去抖"判定。
 *
 * ## 为什么需要去抖
 *
 * 探测走的是 `fs.existsSync`（见 device.ts 的 `findIpodRoots`）。设备刚挂载、
 * 正在刷盘、或恰好在写文件的那一瞬间，都可能一次读不到。若把单次读失败
 * 当作"拔出了"，界面就会闪一下"设备已断开"又跳回来 —— 比不检测更烦人。
 *
 * 所以要求**同一状态被连续观测 N 次**才认账（N 默认 2，即约 2 秒）。
 * 代价是插拔后有最多约 2 秒延迟，换来的是不会误报。
 *
 * ## 为什么单独一个模块
 *
 * 这段逻辑原本内联在 `main/index.ts` 的定时器里，而那个位置需要拉起
 * Electron 才能跑，等于没法测。抽出来之后 `scripts/test-core.js` 的 T10
 * 可以用任意观测序列直接验证 —— 不需要真机，也不需要等真实秒数。
 */

export interface ObserveResult {
  changed: boolean;
  /** 确认后的当前根路径；`changed` 为 false 时表示"仍然是这个" */
  root: string | null;
}

export class StableDetector {
  private current: string | null;
  private candidate: string | null = null;
  private ticks = 0;

  /**
   * @param initial 当前实际状态。传入它可避免启动时把"本来就插着"当成一次插入事件。
   * @param confirmTicks 需要连续观测到几次才认账，最小 1。
   */
  constructor(
    initial: string | null,
    private readonly confirmTicks = 2,
  ) {
    this.current = initial;
  }

  get value(): string | null {
    return this.current;
  }

  /**
   * 喂一次观测结果。
   *
   * @returns `changed: true` 表示状态已确认变化，`root` 是新状态（断开为 `null`）；
   *          `changed: false` 表示尚未确认变化，`root` 仍是旧状态。
   */
  observe(now: string | null): ObserveResult {
    if (now === this.current) {
      // 回到已知状态：清掉待确认的候选，避免"A B A"这类抖动被累积
      this.candidate = null;
      this.ticks = 0;
      return { changed: false, root: this.current };
    }
    if (now === this.candidate) this.ticks++;
    else {
      this.candidate = now;
      this.ticks = 1;
    }
    if (this.ticks < Math.max(1, this.confirmTicks)) {
      return { changed: false, root: this.current };
    }
    this.current = now;
    this.candidate = null;
    this.ticks = 0;
    return { changed: true, root: this.current };
  }
}
