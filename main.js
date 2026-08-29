/*
 * ModalAnimPlus - 核心逻辑
 * 负责在弹窗关闭时制造一个“僵尸”副本，以便执行退场动画。
 */
const { Plugin, Modal } = require("obsidian");

module.exports = class ModalAnimPlus extends Plugin {
  onload() {
    // 僵尸存活时间 (毫秒)
    // 注意：这个时间必须略长于 CSS 中的 --modal-exit-dur，否则动画会被切断
    const ZOMBIE_DURATION = 220;

    // --- 背景状态管理 (优化版：观察者模式) ---
    const updateBackground = () => {
      // 检查界面上是否存在非僵尸的真实弹窗容器
      const realModals = document.querySelectorAll(".modal-container:not(.modal-zombie)");
      
      if (realModals.length > 0) {
        document.body.classList.add("modal-open");
      } else {
        document.body.classList.remove("modal-open");
      }
    };

    const observer = new MutationObserver(updateBackground);
    observer.observe(document.body, { childList: true, subtree: false });
    this.register(() => observer.disconnect());
    updateBackground();

    // --- 拦截关闭过程 ---
    const originalClose = Modal.prototype.close;
    Modal.prototype.close = function (...args) {
      const container = this.containerEl?.closest(".modal-container");
      
      // 只有真实窗口在关闭时才会产生僵尸副本
      if (container && !container.classList.contains("modal-zombie") && document.body.contains(container)) {
        
        // 1. 制造副本 (Clone)
        const zombie = container.cloneNode(true);
        
        // 2. 清理属性防止冲突
        zombie.removeAttribute("id");
        zombie.removeAttribute("style"); 
        
        // 3. 这里的 JS 写死样式是为了保证僵尸在销毁瞬间位置不动
        Object.assign(zombie.style, {
          position: "fixed",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          zIndex: "999", // 确保在最上层
          pointerEvents: "none" // 僵尸不能点
        });

        zombie.classList.add("modal-zombie");
        
        // 4. 将僵尸放入 Body
        document.body.appendChild(zombie);

        // 5. 背景联动：如果是最后一个窗口，提前移除背景类，让背景和僵尸一起退场
        const others = document.querySelectorAll(".modal-container:not(.modal-zombie)");
        if (others.length <= 1) {
           document.body.classList.remove("modal-open");
        }

        // 6. 定时清理
        setTimeout(() => {
          zombie.remove();
        }, ZOMBIE_DURATION);
      }

      // 7. 立即执行原版关闭逻辑，防止 UI 阻塞
      return originalClose.apply(this, args);
    };

    this.register(() => { Modal.prototype.close = originalClose; });
  }
};
