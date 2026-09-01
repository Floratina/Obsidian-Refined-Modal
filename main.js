/*
 * FLRA Animation Helper
 * 给 Obsidian 弹窗补上进出场动画 + 背景模糊。
 *
 * Obsidian 的 Modal.close() 是直接把 DOM 干掉的,没有退场动画的余地。
 * 所以这里猴补丁 close():在真窗口被销毁之前克隆一份"僵尸副本"贴到 body 上,
 * 由副本负责跑退场动画,动画结束后自己消失。
 *
 * 所有视觉参数都是 body 上的 CSS 变量。styles.css 里有一份默认值,
 * 设置面板通过行内样式覆盖它们(行内优先级高于样式表里的普通声明)。
 */
const { Plugin, PluginSettingTab, Setting, Modal, debounce } = require("obsidian");

/* ===== 默认值:与 styles.css 里 body{} 那一块的初始值一一对应 ===== */
const DEFAULTS = {
  // 背景
  bgBlurPixels: 15,
  bgDimOpacity: 0,
  bgContrast: 1.0,
  bgSaturation: 1.26,
  bgScaleTarget: 0.984,
  // 时间 (ms)
  modalInDur: 165,
  modalExitDur: 200,
  bgInDur: 190,
  bgOutDur: 115,
  // 缩放
  modalLargeScale: 0.96,
  modalExitScale: 0.975,
  // 缓动曲线
  modalInEase: "cubic-bezier(.04,.5,.23,1)",
  modalOutEase: "cubic-bezier(.05,.7,.01,1)",
  bgInEase: "cubic-bezier(0.18,0.89,0.32,1)",
  bgOutEase: "cubic-bezier(0.25,0.1,0.25,1)",

  // 右键菜单(入场取值对齐原 snippet,退场是插件独有的新东西)
  menuAnimEnabled: true,
  menuFadeDur: 155,
  menuSlideDur: 120,
  menuScaleDur: 115,
  menuSlideDistance: 7,
  menuScaleStart: 0.985,
  menuInEase: "cubic-bezier(0,.7,.36,1)",
  menuExitDur: 30,
  menuExitScale: 0.985,
  menuOutEase: "cubic-bezier(.3,0,.8,.5)",

  // 毛玻璃
  glassEnabled: true,
  glassTintEnabled: true,
  glassAlpha: 70,
  glassBlur: 10,
  glassBrightness: 1.2,
  glassContrast: 1.0,
  glassSaturation: 1.2,
};

/* 布尔开关:不是 CSS 变量,靠 body 上的类生效 */
const CLASS_KEYS = new Set(["menuAnimEnabled", "glassEnabled", "glassTintEnabled"]);

/* 设置键 -> [CSS 变量名, 单位] */
const VAR_MAP = {
  bgBlurPixels: ["--bg-blur-pixels", "px"],
  bgDimOpacity: ["--bg-dim-opacity", ""],
  bgContrast: ["--bg-contrast", ""],
  bgSaturation: ["--bg-saturation", ""],
  bgScaleTarget: ["--bg-scale-target", ""],
  modalInDur: ["--modal-in-dur", "ms"],
  modalExitDur: ["--modal-exit-dur", "ms"],
  bgInDur: ["--bg-in-dur", "ms"],
  bgOutDur: ["--bg-out-dur", "ms"],
  modalLargeScale: ["--modal-large-scale", ""],
  modalExitScale: ["--modal-exit-scale", ""],
  modalInEase: ["--modal-in-ease", ""],
  modalOutEase: ["--modal-out-ease", ""],
  bgInEase: ["--bg-in-ease", ""],
  bgOutEase: ["--bg-out-ease", ""],
  menuFadeDur: ["--menu-fade-dur", "ms"],
  menuSlideDur: ["--menu-slide-dur", "ms"],
  menuScaleDur: ["--menu-scale-dur", "ms"],
  menuSlideDistance: ["--menu-slide-distance", "px"],
  menuScaleStart: ["--menu-scale-start", ""],
  menuInEase: ["--menu-in-ease", ""],
  menuExitDur: ["--menu-exit-dur", "ms"],
  menuExitScale: ["--menu-exit-scale", ""],
  menuOutEase: ["--menu-out-ease", ""],
  glassAlpha: ["--flra-glass-alpha", "%"],
  glassBlur: ["--flra-glass-blur", "px"],
  glassBrightness: ["--flra-glass-brightness", ""],
  glassContrast: ["--flra-glass-contrast", ""],
  glassSaturation: ["--flra-glass-saturation", ""],
  // 注意:CLASS_KEYS 里那几个布尔开关不是 CSS 变量,故意不在这张表里。
  // 它们由 applyBodyClasses() 切换 body 上的类来生效。
};

/*
 * 缓动曲线选项:自定义 / 默认 / 缓入或缓出 / 线性。
 * 「默认」是这一项在 DEFAULTS 里的手调曲线,各部分(背景、弹窗、菜单)各不相同;
 * 进入的行给 ease-in「缓入」,退出的行给 ease-out「缓出」。
 * 若默认值恰好等于其中某条,就不再重复列出。
 */
const EASE_IN = "cubic-bezier(0.42,0,1,1)"; // CSS 的 ease-in
const EASE_OUT = "cubic-bezier(0,0,0.58,1)"; // CSS 的 ease-out
const EASE_LINEAR = "cubic-bezier(0,0,1,1)";

/** 返回 [值 -> 显示名] 的有序表,不含「自定义」 */
function easeOptionsFor(key) {
  const exiting = /out/i.test(key);
  const opts = { [DEFAULTS[key]]: "默认" };
  const pairs = exiting ? [[EASE_OUT, "缓出"]] : [[EASE_IN, "缓入"]];
  pairs.push([EASE_LINEAR, "线性"]);
  for (const [value, label] of pairs) {
    if (!(value in opts)) opts[value] = label;
  }
  return opts;
}

/*
 * 把 CSS 时间值解析成毫秒。
 * 注意:自定义属性不会被计算成时间值,getComputedStyle 拿到的是原始 token
 * 字符串("185ms" / "0.2s"),所以必须自己解析。
 */
function parseDur(raw, fallback) {
  const m = String(raw).trim().match(/^([\d.]+)\s*(ms|s)?$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return fallback;
  return m[2] === "s" ? n * 1000 : n;
}

module.exports = class FlraAnimationHelper extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());

    // 每个僵尸副本对应一个 kill 函数,卸载时统一清场
    this.zombies = new Set();
    this.register(() => {
      for (const kill of [...this.zombies]) kill();
    });

    // 拖滑块时会连续触发 onChange,落盘节流,避免疯狂写 data.json
    this.saveDebounced = debounce(() => this.saveData(this.settings), 400, true);
    this.register(() => {
      // 取消挂起的节流写入,然后补最后一次,保证刚拖完就禁用插件也不丢设置
      this.saveDebounced.cancel?.();
      this.saveData(this.settings);
    });

    this.applyVars();
    this.register(() => this.clearVars());

    this.setupPointerTracking();
    this.setupBodyObserver();
    this.patchModalClose();

    this.addSettingTab(new FlraSettingTab(this.app, this));
  }

  /* ===== 设置 <-> CSS 变量 ===== */

  applyVar(key) {
    const entry = VAR_MAP[key];
    // menuAnimEnabled 这类布尔开关不是 CSS 变量,不在表里,直接跳过
    if (!entry) return;
    const [name, unit] = entry;
    document.body.style.setProperty(name, `${this.settings[key]}${unit}`);
  }

  applyVars() {
    for (const key of Object.keys(VAR_MAP)) this.applyVar(key);
    this.applyBodyClasses();
  }

  /** 几个布尔开关:CSS 那边靠 body 上的类生效 */
  applyBodyClasses() {
    const b = document.body;
    b.classList.toggle("flra-menu-anim", !!this.settings.menuAnimEnabled);
    b.classList.toggle("flra-glass", !!this.settings.glassEnabled);
    b.classList.toggle("flra-glass-tint", !!this.settings.glassTintEnabled);
  }

  clearVars() {
    for (const key of Object.keys(VAR_MAP)) {
      document.body.style.removeProperty(VAR_MAP[key][0]);
    }
    document.body.classList.remove("flra-menu-anim", "flra-glass", "flra-glass-tint");
  }

  /** 立即生效 + 延迟落盘。传 key 只更新那一项(拖滑块时每帧都会调) */
  applyAndSave(key) {
    if (!key) this.applyVars();
    else if (CLASS_KEYS.has(key)) this.applyBodyClasses();
    else this.applyVar(key);
    this.saveDebounced();
  }

  /* ===== body 观察者:背景状态 + 菜单出现/移除 ===== */

  /*
   * 记录最近的指针位置,用来判断菜单是向上还是向下展开。
   * 只存两个数,回调开销可以忽略;capture 阶段保证别人 stopPropagation 也拦不住。
   * pointermove 是必要的 —— 二级子菜单由悬停触发,没有 pointerdown 可用。
   */
  setupPointerTracking() {
    this.lastPointer = null;
    const track = (e) => {
      this.lastPointer = { y: e.clientY, t: performance.now() };
    };
    const opts = { capture: true, passive: true };
    this.registerDomEvent(document, "pointermove", track, opts);
    this.registerDomEvent(document, "pointerdown", track, opts);
  }

  /*
   * 判断菜单的展开方向,向上展开的打上 flra-menu-up,让 CSS 把滑动整个镜像。
   *
   * Obsidian 没有提供翻转标记(MenuPositionDef 只有横向的 left),只能自己算。
   * 这里刻意读行内 style.top 而不是 getBoundingClientRect() —— 后者会强制同步
   * 布局,在这个 vault 里(627KB 主题 + 50 个 snippet)一次全文档重算要几十毫秒。
   * style.top 是 Obsidian 自己刚写进去的字符串,读它不触发任何布局。
   *
   * 前提:菜单是 fixed 定位,top 即视口坐标。读不出来就按默认的向下展开处理。
   */
  markMenuDirection(menuEl) {
    const top = parseFloat(menuEl.style.top);
    const p = this.lastPointer;
    // 指针位置太旧(键盘唤起、showAtPosition 等)就不猜,按向下处理
    const fresh = p && performance.now() - p.t < 2000;
    const openedUp = fresh && isFinite(top) && top < p.y - 4;
    menuEl.classList.toggle("flra-menu-up", !!openedUp);
  }

  setupBodyObserver() {
    const update = (records) => {
      // 僵尸副本不算真窗口,不能让它把背景吊着
      const hasReal = document.querySelector(".modal-container:not(.modal-zombie)") !== null;
      document.body.classList.toggle("modal-open", hasReal);

      if (!records || !this.settings.menuAnimEnabled) return;

      for (const rec of records) {
        // 菜单刚出现:标记展开方向。这里跑在微任务里,早于首帧绘制,
        // 所以类能赶在入场动画开始之前挂上。
        for (const node of rec.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!node.classList.contains("menu")) continue;
          // 副本的方向是克隆时带过来的,不能按当前指针重新算
          if (node.classList.contains("flra-menu-zombie")) continue;
          this.markMenuDirection(node);
        }

        // 菜单关闭时是被直接 detach 的,CSS 再没有作用对象 ——
        // 在这里接住被摘掉的节点,克隆一份贴回去承载退场动画。
        for (const node of rec.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!node.classList.contains("menu")) continue;
          // 副本自己被移除时同样会走到这里,不挡掉就会无限自我复制
          if (node.classList.contains("flra-menu-zombie")) continue;
          try {
            this.spawnMenuZombie(node);
          } catch (e) {
            console.error("[FLRA Animation Helper] 生成菜单退场副本失败", e);
          }
        }
      }
    };

    // Obsidian 把 .modal-container 和 .menu(含二级子菜单)都直接挂在 body 下,
    // 不需要 subtree。代价:setParentElement() 改过父元素的菜单、以及 popout
    // 窗口里的,不在观察范围内,不会有动画。
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: false });

    this.register(() => {
      observer.disconnect();
      document.body.classList.remove("modal-open");
    });

    update();
  }

  /* ===== 拦截关闭过程 ===== */

  patchModalClose() {
    const plugin = this;
    const originalClose = Modal.prototype.close;
    let active = true;

    const patched = function (...args) {
      if (active) {
        // 副本生成失败绝不能连累弹窗关不掉
        try {
          plugin.spawnZombie(this);
        } catch (e) {
          console.error("[FLRA Animation Helper] 生成退场副本失败", e);
        }
      }
      return originalClose.apply(this, args);
    };

    Modal.prototype.close = patched;

    this.register(() => {
      // 先让包装层变成透传,这样即使摘不掉也已经无害
      active = false;
      // 只有我们还在补丁链顶端时才摘除,否则会抹掉后来者的补丁
      if (Modal.prototype.close === patched) {
        Modal.prototype.close = originalClose;
      }
    });
  }

  /** 克隆一份"僵尸副本"来承载退场动画 */
  spawnZombie(modal) {
    const container = modal?.containerEl?.closest(".modal-container");
    if (!container) return;
    if (container.classList.contains("modal-zombie")) return;
    // close() 可能被调用多次,容器已经不在 DOM 里说明这次是重复调用
    if (!document.body.contains(container)) return;

    const zombie = container.cloneNode(true);
    zombie.removeAttribute("id");
    // 清掉 Obsidian 自己写的行内样式,布局交给 styles.css 的 .modal-zombie 规则
    zombie.removeAttribute("style");
    zombie.classList.add("modal-zombie");
    document.body.appendChild(zombie);

    // 背景联动:如果这是最后一个真窗口,提前撤掉背景,让它和副本一起退场
    if (document.querySelectorAll(".modal-container:not(.modal-zombie)").length <= 1) {
      document.body.classList.remove("modal-open");
    }

    this.reap(zombie, "--modal-exit-dur", this.settings.modalExitDur);
  }

  /** 克隆一份菜单副本来承载退场动画 */
  spawnMenuZombie(menuEl) {
    const zombie = menuEl.cloneNode(true);
    zombie.removeAttribute("id");
    // 和弹窗副本相反:这里绝不能清掉行内 style ——
    // 菜单的 top/left 定位就写在里面,清了副本会跑到屏幕左上角
    zombie.classList.add("flra-menu-zombie");
    document.body.appendChild(zombie);

    this.reap(zombie, "--menu-exit-dur", this.settings.menuExitDur);
  }

  /**
   * 让副本跑完退场动画后自我销毁。弹窗和菜单共用。
   * durVar 是决定时长的 CSS 变量名 —— 走计算样式而不是直接读 settings,
   * 这样用户额外写 CSS snippet 覆盖变量时也能自动跟上。
   */
  reap(zombie, durVar, fallbackMs) {
    const dur = parseDur(getComputedStyle(document.body).getPropertyValue(durVar), fallbackMs);

    let done = false;
    let timer = 0;
    const kill = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      zombie.remove();
      this.zombies.delete(kill);
    };

    zombie.addEventListener("animationend", (e) => {
      // animationend 会冒泡,内部元素也可能在跑动画,只认容器自己的
      if (e.target === zombie) kill();
    });

    // 兜底:动画压根没跑起来(display:none、被 animation:none 覆盖等)时也要清掉
    timer = window.setTimeout(kill, dur + 80);
    this.zombies.add(kill);
  }
};

/* ===== 设置面板 ===== */
/*
 * 设置面板。
 *
 * 参数已经有 32 项,平铺一屏根本扫不完,所以做成顶部标签页:
 * 「预览」常驻在标签栏上方(调任何一组参数都要用它),「重置全部」常驻在底部,
 * 中间的内容区随标签切换重绘。
 *
 * !! 所有自定义成员一律加 flra 前缀,只有 display() 例外(它是 API 约定)。
 * 起因是这里踩过一次:原先有个方法叫 renderTab(),而 Obsidian 1.13 重做后的
 * 设置系统里 SettingTab 基类自己就有 renderTab(),被覆盖后 Obsidian 调用它时
 * 不传参,于是 new Setting(undefined) 抛错,整个设置页白屏。
 * 继承第三方基类时,任何不加前缀的成员名都是地雷 —— 对方随时可能加同名方法。
 */

const TABS = [
  ["bg", "背景"],
  ["modal", "弹窗"],
  ["menu", "右键菜单"],
  ["glass", "毛玻璃"],
];

class FlraSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.flraActiveTab = TABS[0][0];
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    this.flraRenderPreview(containerEl);

    const bar = containerEl.createDiv({ cls: "flra-tab-bar" });
    const body = containerEl.createDiv({ cls: "flra-tab-body" });

    for (const [id, label] of TABS) {
      const tab = bar.createDiv({ cls: "flra-tab", text: label });
      tab.toggleClass("is-active", this.flraActiveTab === id);
      tab.addEventListener("click", () => {
        if (this.flraActiveTab === id) return;
        this.flraActiveTab = id;
        // 只重画标签状态和内容区,常驻的预览/重置不动
        for (const el of Array.from(bar.children)) el.toggleClass("is-active", el === tab);
        body.empty();
        this.flraRenderActiveTab(body);
      });
    }

    this.flraRenderActiveTab(body);
    this.flraRenderResetAll(containerEl);
  }

  flraRenderActiveTab(el) {
    if (this.flraActiveTab === "bg") this.flraRenderBg(el);
    else if (this.flraActiveTab === "modal") this.flraRenderModal(el);
    else if (this.flraActiveTab === "menu") this.flraRenderMenu(el);
    else if (this.flraActiveTab === "glass") this.flraRenderGlass(el);
  }

  /* ===== 常驻区 ===== */

  flraRenderPreview(el) {
    const preview = new Setting(el)
      .setName("预览动画")
      .setDesc("打开一个测试弹窗,直接看当前参数的进出场效果。")
      .addButton((b) =>
        b
          .setButtonText("打开测试弹窗")
          .setCta()
          .onClick(() => new PreviewModal(this.app).open())
      );

    // 设置面板被拖到独立窗口时,测试弹窗未必开在同一个窗口里
    if (el.ownerDocument !== document) {
      preview.setDesc(
        "打开一个测试弹窗,直接看当前参数的进出场效果。" +
          "你的设置面板在独立窗口里,测试弹窗可能出现在主窗口 —— 没看到的话切过去看看。"
      );
    }
  }

  flraRenderResetAll(el) {
    // 破坏性操作,放在最底部而不是顶部,不该出现在容易误点的位置
    new Setting(el)
      .setName("重置全部参数")
      .setDesc("把所有标签页里的参数一次性恢复到插件默认值。")
      .addButton((b) =>
        b
          .setButtonText("重置全部")
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, {
              title: "重置全部参数",
              body: "所有标签页里的参数都会恢复到插件默认值,当前手调的数值会丢失,且无法撤销。",
              confirmText: "重置",
              onConfirm: () => {
                Object.assign(this.plugin.settings, DEFAULTS);
                this.plugin.applyAndSave(); // 不传 key = 全量写入
                this.display(); // 重绘面板,把所有控件同步过来
              },
            }).open();
          })
      );
  }

  /* ===== 各标签页内容 ===== */

  flraRenderBg(el) {
    this.flraSlider(el, {
      name: "模糊强度",
      desc: "弹窗打开时背景的高斯模糊半径。",
      key: "bgBlurPixels",
      min: 0,
      max: 40,
      step: 1,
      suffix: "px",
    });

    this.flraSlider(el, {
      name: "变暗程度",
      desc: "0 = 完全不变暗,100 = 全黑。",
      key: "bgDimOpacity",
      min: 0,
      max: 100,
      step: 1,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "对比度",
      desc: "100% 为原始对比度。",
      key: "bgContrast",
      min: 50,
      max: 150,
      step: 1,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "饱和度",
      desc: "100% 为原始饱和度,略微提高能让模糊后的背景不发灰。",
      key: "bgSaturation",
      min: 0,
      max: 200,
      step: 1,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "背景缩放",
      desc:
        "弹窗打开时背景的缩放目标。大于 100% 是推远(配合由大变小的入场)," +
        "小于 100% 是收缩(配合由小变大的弹出式入场)。100% 为不缩放。",
      key: "bgScaleTarget",
      min: 80,
      max: 150,
      step: 0.1,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "背景进入时长",
      desc: "背景模糊与缩放的进入耗时。",
      key: "bgInDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "背景退出时长",
      desc: "背景模糊与缩放的恢复耗时。通常比进入更短会更利落。",
      key: "bgOutDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraEase(el, { name: "背景进入曲线", key: "bgInEase" });
    this.flraEase(el, { name: "背景退出曲线", key: "bgOutEase" });
  }

  flraRenderModal(el) {
    this.flraSlider(el, {
      name: "入场时长",
      desc: "弹窗出现时的动画耗时。",
      key: "modalInDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "出场时长",
      desc: "弹窗消失时的动画耗时。退场副本的存活时间会自动跟随这个值。",
      key: "modalExitDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "入场起始尺寸",
      desc: "弹窗从这个尺寸缩到 100%。大于 100% 是「由大变小」,小于则是「弹出」。",
      key: "modalLargeScale",
      min: 80,
      max: 130,
      step: 0.5,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "出场结束尺寸",
      desc: "弹窗从 100% 缩放到这个尺寸后消失。",
      key: "modalExitScale",
      min: 80,
      max: 130,
      step: 0.5,
      scale: 100,
      suffix: "%",
    });

    this.flraEase(el, { name: "入场曲线", key: "modalInEase" });
    this.flraEase(el, { name: "出场曲线", key: "modalOutEase" });
  }

  flraRenderMenu(el) {
    this.flraToggle(el, {
      name: "启用右键菜单动画",
      desc:
        "给右键菜单加上入场和退场动画。退场动画是插件独有的 —— " +
        "菜单关闭时会被直接从 DOM 上摘掉,纯 CSS 没有作用对象,做不到这件事。",
      key: "menuAnimEnabled",
    });

    this.flraSlider(el, {
      name: "淡入时长",
      desc: "菜单透明度从 0 到 1 的耗时。",
      key: "menuFadeDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "滑动时长",
      desc: "菜单滑动到位、同时展开裁剪的耗时。方向自动跟随菜单的展开方向。",
      key: "menuSlideDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "缩放时长",
      desc: "菜单缩放到原尺寸的耗时。可以和上面两项设成不同值,做出错落感。",
      key: "menuScaleDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "滑动距离",
      desc: "菜单入场时从多远处滑过来。向下展开的从上方滑下来,向上展开的从下方滑上去。",
      key: "menuSlideDistance",
      min: 0,
      max: 80,
      step: 1,
      suffix: "px",
    });

    this.flraSlider(el, {
      name: "缩放起始尺寸",
      desc: "菜单从这个尺寸放大到 100%。",
      key: "menuScaleStart",
      min: 50,
      max: 130,
      step: 0.5,
      scale: 100,
      suffix: "%",
    });

    this.flraEase(el, { name: "入场曲线", key: "menuInEase" });

    this.flraSlider(el, {
      name: "退场时长",
      desc: "菜单消失时的动画耗时。",
      key: "menuExitDur",
      min: 0,
      max: 800,
      step: 5,
      suffix: "ms",
    });

    this.flraSlider(el, {
      name: "退场结束尺寸",
      desc: "菜单从 100% 缩放到这个尺寸后消失。",
      key: "menuExitScale",
      min: 50,
      max: 130,
      step: 0.5,
      scale: 100,
      suffix: "%",
    });

    this.flraEase(el, { name: "退场曲线", key: "menuOutEase" });
  }

  flraRenderGlass(el) {
    this.flraToggle(el, {
      name: "启用毛玻璃",
      desc:
        "把弹窗、命令面板、右键菜单和编辑器补全浮层换成半透明毛玻璃。" +
        "注意:这会让每次弹出都多一次背景模糊渲染,机器吃力的话先关掉这个。",
      key: "glassEnabled",
    });

    this.flraToggle(el, {
      name: "保留原背景色",
      desc:
        "开启时按下面的不透明度混入控件原本的背景色(弹窗用主背景色、菜单用次级背景色)。" +
        "关闭则是完全无色的纯玻璃,只剩模糊和滤镜效果。",
      key: "glassTintEnabled",
    });

    this.flraSlider(el, {
      name: "背景色不透明度",
      desc: "100% = 完全不透明(看不出玻璃),0% = 完全透明。仅在上一项开启时有效。",
      key: "glassAlpha",
      min: 0,
      max: 100,
      step: 1,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "模糊半径",
      desc: "玻璃背后的高斯模糊半径。和「背景」标签页里那个是各自独立的。",
      key: "glassBlur",
      min: 0,
      max: 60,
      step: 1,
      suffix: "px",
    });

    this.flraSlider(el, {
      name: "背景亮度",
      desc: "100% 为原始亮度。调高做出「亮玻璃」,调低做出「暗玻璃」。",
      key: "glassBrightness",
      min: 20,
      max: 200,
      step: 1,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "背景对比度",
      desc: "100% 为原始对比度。",
      key: "glassContrast",
      min: 20,
      max: 200,
      step: 1,
      scale: 100,
      suffix: "%",
    });

    this.flraSlider(el, {
      name: "背景饱和度",
      desc: "100% 为原始饱和度。适度提高能让玻璃背后的颜色更透亮。",
      key: "glassSaturation",
      min: 0,
      max: 300,
      step: 1,
      scale: 100,
      suffix: "%",
    });
  }

  /* ===== 控件辅助方法 ===== */

  /**
   * 数值滑块 + 重置按钮。
   * scale 用于「界面按百分比显示、内部按倍数存储」:界面值 = 存储值 * scale。
   */
  flraSlider(containerEl, { name, desc, key, min, max, step, scale = 1, suffix = "" }) {
    // 浮点误差:1.005 * 100 === 100.49999999999999,不修一下滑块会落在错的档位
    const toShown = (stored) => Math.round(stored * scale * 1000) / 1000;
    let comp;

    new Setting(containerEl)
      .setName(name)
      .setDesc(suffix ? `${desc}(单位 ${suffix})` : desc)
      .addSlider((s) => {
        comp = s;
        s.setLimits(min, max, step)
          .setValue(toShown(this.plugin.settings[key]))
          .setDynamicTooltip()
          .onChange((v) => {
            this.plugin.settings[key] = scale === 1 ? v : v / scale;
            this.plugin.applyAndSave(key);
          });
      })
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip(`恢复默认值 ${toShown(DEFAULTS[key])}${suffix}`)
          .onClick(() => {
            this.plugin.settings[key] = DEFAULTS[key];
            comp.setValue(toShown(DEFAULTS[key]));
            this.plugin.applyAndSave(key);
          })
      );
  }

  /** 布尔开关 + 重置按钮 */
  flraToggle(containerEl, { name, desc, key }) {
    let comp;

    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) => {
        comp = t;
        t.setValue(!!this.plugin.settings[key]).onChange((v) => {
          this.plugin.settings[key] = v;
          this.plugin.applyAndSave(key);
        });
      })
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip(`恢复默认值(${DEFAULTS[key] ? "开启" : "关闭"})`)
          .onClick(() => {
            this.plugin.settings[key] = DEFAULTS[key];
            comp.setValue(DEFAULTS[key]);
            this.plugin.applyAndSave(key);
          })
      );
  }

  /**
   * 缓动曲线行:下拉 + 文本框 + 重置按钮。
   *
   * 选中具名预设时文本框锁定(只读展示),选「自定义」才解锁手写。
   * 这样就不会出现"下拉显示某预设、文本框却是别的值"的错位状态。
   */
  flraEase(containerEl, { name, key }) {
    let dropdown;
    let text;
    // 程序性地同步控件时要屏蔽 onChange,否则会误触"切到自定义"的分支
    let syncing = false;
    const options = easeOptionsFor(key);

    /** 把两个控件和禁用态一起对齐到给定值 */
    const sync = (v) => {
      syncing = true;
      const preset = v in options;
      dropdown.setValue(preset ? v : "");
      text.setValue(v);
      text.setDisabled(preset);
      text.inputEl.removeClass("flra-invalid");
      syncing = false;
    };

    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc("选「自定义」可手写 cubic-bezier(...)。");

    setting.addDropdown((d) => {
      dropdown = d;
      d.addOption("", "自定义");
      for (const [value, label] of Object.entries(options)) d.addOption(value, label);
      d.onChange((v) => {
        if (syncing) return;
        if (!v) {
          // 切到自定义:解锁输入框,值先保持不变,等用户改
          text.setDisabled(false);
          text.inputEl.focus();
          return;
        }
        this.plugin.settings[key] = v;
        sync(v);
        this.plugin.applyAndSave(key);
      });
    });

    setting.addText((t) => {
      text = t;
      t.setPlaceholder("cubic-bezier(.25,.1,.25,1)").onChange((v) => {
        if (syncing) return;
        const val = v.trim();
        const ok = val !== "" && CSS.supports("transition-timing-function", val);
        t.inputEl.toggleClass("flra-invalid", !ok);
        // 非法值不写入,保留上一个能用的值
        if (!ok) return;
        this.plugin.settings[key] = val;
        this.plugin.applyAndSave(key);
      });
      t.inputEl.addClass("flra-ease-input");
    });

    setting.addExtraButton((b) =>
      b
        .setIcon("rotate-ccw")
        .setTooltip("恢复默认曲线")
        .onClick(() => {
          this.plugin.settings[key] = DEFAULTS[key];
          sync(DEFAULTS[key]);
          this.plugin.applyAndSave(key);
        })
    );

    sync(this.plugin.settings[key]); // 初始化:两个控件都要建好之后才能调
  }
}

/* ===== 用来试参数的测试弹窗 ===== */

class PreviewModal extends Modal {
  onOpen() {
    this.titleEl.setText("动画预览");
    this.contentEl.createEl("p", {
      text: "这是一个用来试参数的测试弹窗。按 Esc、点击外部区域或下面的按钮关闭,就能看到退场动画。",
    });
    this.contentEl.createEl("p", {
      text: "参数改完立即生效,可以反复打开对比手感。",
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("关闭")
        .setCta()
        .onClick(() => this.close())
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ===== 破坏性操作的确认弹窗 ===== */

class ConfirmModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
  }

  onOpen() {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });

    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.opts.confirmText)
          .setWarning()
          .onClick(() => {
            this.close();
            this.opts.onConfirm();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
