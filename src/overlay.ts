import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Config, Options } from "./Config";

/* TODO: Some kind of rendering config */
const SCALE = 3;
const RATIO = SCALE * 2 /* Canvas is 2x'ed */ * 1.4; /* line height */

const Theme = EditorView.theme({
  ".cm-minimap-overlay-container": {
    position: "absolute",
    top: 0,
    height: "100%",
    width: "100%",
    "&.cm-minimap-overlay-mouse-over": {
      opacity: 0,
      transition: "visibility 0s linear 300ms, opacity 300ms",
    },
    "&.cm-minimap-overlay-mouse-over:hover": {
      opacity: 1,
      transition: "visibility 0s linear 0ms, opacity 300ms",
    },
    "& .cm-minimap-overlay": {
      background: "rgb(121, 121, 121)",
      opacity: "0.2",
      position: "absolute",
      right: 0,
      top: 0,
      width: "100%",
      transition: "top 0s ease-in 0ms",
      "&:hover": {
        opacity: "0.3",
      },
    },
    "&.cm-minimap-overlay-active": {
      opacity: 1,
      visibility: "visible",
      transition: "visibility 0s linear 0ms, opacity 300ms",
      "& .cm-minimap-overlay": {
        opacity: "0.4",
      },
    },
  },
});

const OverlayView = ViewPlugin.fromClass(
  class {
    private container: HTMLDivElement;
    private dom: HTMLDivElement;
    private _isDragging: boolean = false;
    private _dragStartY: number | undefined;

    public constructor(private view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.classList.add("cm-minimap-overlay");

      this.container = document.createElement("div");
      this.container.classList.add("cm-minimap-overlay-container");
      this.container.appendChild(this.dom);

      this.computeHeight();
      this.computeTop();

      // Attach event listeners for overlay
      this.container.addEventListener("mousedown", this.onMouseDown.bind(this));
      window.addEventListener("mouseup", this.onMouseUp.bind(this));
      window.addEventListener("mousemove", this.onMouseMove.bind(this));

      // Attach the overlay elements to the minimap
      const inner = this.view.dom.querySelector(".cm-minimap-inner");
      if (inner) {
        inner.appendChild(this.container);
      }

      // Initially set overlay configuration styles
      const { showOverlay } = view.state.facet(Config);
      this.setShowOverlay(showOverlay);
    }

    update(update: ViewUpdate) {
      const { showOverlay } = update.state.facet(Config);
      const { showOverlay: prevShowOverlay } = update.startState.facet(Config);

      if (showOverlay !== prevShowOverlay) {
        this.setShowOverlay(showOverlay);
      }

      if (update.geometryChanged) {
        this.computeHeight();
        this.computeTop();
      }
    }

    public computeHeight() {
      const height = this.view.dom.clientHeight / RATIO;
      this.dom.style.height = height + "px";
    }

    public computeTop() {
      if (!this._isDragging) {
        const top = currentTopFromScrollHeight(
          this.view.dom.clientHeight,
          this.view.scrollDOM.scrollTop,
          this.view.scrollDOM.scrollHeight
        );
        this.dom.style.top = top + "px";
      }
    }

    public setShowOverlay(showOverlay: Required<Options>["showOverlay"]) {
      if (showOverlay === "mouse-over") {
        this.container.classList.add("cm-minimap-overlay-mouse-over");
      } else {
        this.container.classList.remove("cm-minimap-overlay-mouse-over");
      }
    }

    private onMouseDown(event: MouseEvent) {
      // Ignore right click
      if (event.button === 2) {
        return;
      }

      // If target is the overlay start dragging
      const { clientY, target } = event;
      if (target === this.dom) {
        this._dragStartY = event.clientY;
        this._isDragging = true;
        this.container.classList.add("cm-minimap-overlay-active");
        return;
      }

      // Updates the scroll position of the EditorView based on the
      // position of the MouseEvent on the minimap canvas
      const { clientHeight, scrollHeight, scrollTop } = this.view.scrollDOM;
      const targetTop = (target as HTMLElement).getBoundingClientRect().top;
      const deltaY = (clientY - targetTop) * RATIO;

      const scrollRatio = scrollTop / (scrollHeight - clientHeight);
      const visibleRange = clientHeight * RATIO - clientHeight;
      const visibleTop = visibleRange * scrollRatio;

      const top = Math.max(0, scrollTop - visibleTop);
      this.view.scrollDOM.scrollTop = top + deltaY - clientHeight / 2;
    }

    private onMouseUp(_event: MouseEvent) {
      // Stop dragging on mouseup
      if (this._isDragging) {
        this._dragStartY = undefined;
        this._isDragging = false;
        this.container.classList.remove("cm-minimap-overlay-active");
      }
    }

    private onMouseMove(event: MouseEvent) {
      if (!this._isDragging) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Without an existing position, we're just beginning to drag.
      if (!this._dragStartY) {
        this._dragStartY = event.clientY;
        return;
      }

      const deltaY = event.clientY - this._dragStartY;
      const movingUp = deltaY < 0;
      const movingDown = deltaY > 0;

      // Update drag position for the next tick
      this._dragStartY = event.clientY;

      const canvasHeight = this.dom.getBoundingClientRect().height;
      const canvasAbsTop = this.dom.getBoundingClientRect().y;
      const canvasAbsBot = canvasAbsTop + canvasHeight;
      const canvasRelTop = parseInt(this.dom.style.top);
      const canvasRelTopDouble = parseFloat(this.dom.style.top);

      const scrollPosition = this.view.scrollDOM.scrollTop;
      const editorHeight = this.view.scrollDOM.clientHeight;
      const contentHeight = this.view.scrollDOM.scrollHeight;

      const atTop = scrollPosition === 0;
      const atBottom =
        Math.round(scrollPosition) >= Math.round(contentHeight - editorHeight);

      // We allow over-dragging past the top/bottom, but the overlay just sticks
      // to the top or bottom of its range. These checks prevent us from immediately
      // moving the overlay when the drag changes direction. We should wait until
      // the cursor has returned to, and begun to pass the bottom/top of the range
      if ((atTop && movingUp) || (atTop && event.clientY < canvasAbsTop)) {
        return;
      }
      if (
        (atBottom && movingDown) ||
        (atBottom && event.clientY > canvasAbsBot)
      ) {
        return;
      }

      // Set view scroll directly

      const scrollHeight = this.view.scrollDOM.scrollHeight;
      const clientHeight = this.view.scrollDOM.clientHeight;

      const maxTopNonOverflowing = (scrollHeight - clientHeight) / RATIO;
      const maxTopOverflowing = clientHeight - clientHeight / RATIO;

      const change = canvasRelTopDouble + deltaY;
      // console.log("canvasrel", canvasRelTopDouble);

      /**
       * ScrollPosOverflowing is calculated by:
       * - Calculating the offset (change) relative to the total height of the container
       * - Multiplying by the maximum scrollTop position for the scroller
       * - The maximum scrollTop position for the scroller is the total scroll height minus the client height
       */
      const relativeToMax = change / maxTopOverflowing;
      const scrollPosOverflowing =
        (scrollHeight - clientHeight) * relativeToMax;

      const scrollPosNonOverflowing = change * RATIO;
      this.view.scrollDOM.scrollTop = Math.max(
        scrollPosOverflowing,
        scrollPosNonOverflowing
      );

      // view.scrollDOM truncates if out of bounds. We need to mimic that behavior here with min/max guard
      const top = Math.min(
        Math.max(0, change),
        Math.min(maxTopOverflowing, maxTopNonOverflowing)
      );
      this.dom.style.top = top + "px";
    }

    public destroy() {
      this.container.removeEventListener("mousedown", this.onMouseDown);
      window.removeEventListener("mouseup", this.onMouseUp);
      window.removeEventListener("mousemove", this.onMouseMove);
      this.container.remove();
    }
  },
  {
    eventHandlers: {
      scroll() {
        requestAnimationFrame(() => this.computeTop());
      },
    },
  }
);

export function Overlay(): Extension {
  return [Theme, OverlayView];
}

export function currentTopFromScrollHeight(
  clientHeight: number,
  scrollTop: number,
  scrollHeight: number
) {
  const maxScrollTop = scrollHeight - clientHeight;

  const topForNonOverflowing = scrollTop / RATIO;

  const height = clientHeight / RATIO;
  const maxTop = clientHeight - height;
  const scrollRatio = scrollTop / maxScrollTop;
  const topForOverflowing = maxTop * scrollRatio;

  // Use tildes to negate any `NaN`s
  const top = Math.min(~~topForOverflowing, ~~topForNonOverflowing);

  return top;
}
