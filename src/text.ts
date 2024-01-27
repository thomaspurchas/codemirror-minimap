import { LineBasedState } from "./linebasedstate";
import { Highlighter, highlightTree } from "@lezer/highlight";
import { highlightingFor, forceParsing, syntaxTree } from "@codemirror/language";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { DrawContext } from "./types";
import { Config, Options, Scale } from "./Config";
import { LinesState, foldsChanged } from "./LinesState";
import { EditorState } from "@codemirror/state";
import crelt from "crelt";

type TagSpan = { text: string; tags: string };
type FontInfo = { color: string; font: string; lineHeight: number };

export class TextState extends LineBasedState<Array<TagSpan>> {
  private _previousParsePos: number = 0;
  private _displayText: Required<Options>["displayText"] | undefined;
  private _fontInfoMap: Map<string, FontInfo> = new Map();
  private _themeClasses: Set<string> | undefined;
  private _highlightingCallbackId: number | undefined;
  private _parseCallbackId: number | undefined;
  private _updateMapCallbackId: number | undefined;
  private _updateCallbackId: number | undefined;

  public constructor(view: EditorView) {
    super(view);

    this._themeClasses = new Set(view.dom.classList.values());

    // if (view.state.facet(Config).enabled) {
    //   // Use setTimeout to break mini-map rendering into next frame
    //   // to prevent the UI from getting stuck for too long.
    //   setTimeout(() => this.updateImpl(view.state, view));
    // }
  }

  private shouldUpdate(update: ViewUpdate) {
    // If the doc changed
    if (update.docChanged) {
      if (update.startState.doc.length < update.state.doc.length) {
        for (let i = update.startState.doc.lines; i <= update.state.doc.lines; i++) {
          // this.map.delete(i);
        }
      }
      return true;
    }

    // If the parser has made more progress
    if (syntaxTree(update.state).length > this._previousParsePos) {
      return true;
    }

    // If configuration settings changed
    if (update.state.facet(Config) !== update.startState.facet(Config)) {
      this.map.clear();
      return true;
    }

    // If the theme changed
    if (this.themeChanged()) {
      this.map.clear();
      return true;
    }

    // If the folds changed
    if (foldsChanged(update.transactions)) {
      this.map.clear();
      return true;
    }

    return false;
  }

  public update(update: ViewUpdate) {
    if (!this.shouldUpdate(update)) {
      return;
    }

    this.cancelScheduledIdleCallback(this._highlightingCallbackId);
    this.cancelScheduledIdleCallback(this._parseCallbackId);
    this.cancelScheduledIdleCallback(this._updateMapCallbackId);

    // Perform update in an idle callback because mini-map
    // calculations can be expensive
    this._updateCallbackId = this.scheduleIdleCallback((deadline?: IdleDeadline) => {
      this.updateImpl(update.state, update.view, deadline);
    }, { timeout: 0 })
  }

  private updateImpl(state: EditorState, view: EditorView, deadline?: IdleDeadline) {
    /* Store display text setting for rendering */
    this._displayText = state.facet(Config).displayText;

    /* If class list has changed, clear and recalculate the font info map */
    if (this.themeChanged()) {
      this._fontInfoMap.clear();
    }

    /* Get the existing parsed tree, which is likely incomplete as parsing 
    takes time. We keep updating the mini-map highlights as parsing
    continues in the background 
    
    This approach ensure that parsing and highlighting don't stall the
    entire UI while parsing is happening */
    const tree = syntaxTree(state);

    if (tree) {
      // Update the parse distance so we can detect when the parser has made progress
      this._previousParsePos = tree.length;

      /**
       * The viewport renders a few extra lines above and below the editor view. To approximate
       * the lines visible in the minimap, we multiply the lines in the viewport by the scale multipliers.
       *
       * Based on the current scroll position, the minimap may show a larger portion of lines above or
       * below the lines currently in the editor view. On a long document, when the scroll position is
       * near the top of the document, the minimap will show a small number of lines above the lines
       * in the editor view, and a large number of lines below the lines in the editor view.
       *
       * To approximate this ratio, we can use the viewport scroll percentage
       *
       * ┌─────────────────────┐
       * │                     │
       * │   Extra viewport    │
       * │   buffer            │
       * ├─────────────────────┼───────┐
       * │                     │Minimap│
       * │                     │Gutter │
       * │                     ├───────┤
       * │    Editor View      │Scaled │
       * │                     │View   │
       * │                     │Overlay│
       * │                     ├───────┤
       * │                     │       │
       * │                     │       │
       * ├─────────────────────┼───────┘
       * │                     │
       * │    Extra viewport   │
       * │    buffer           │
       * └─────────────────────┘
       *
       **/

      const vpLineTop = state.doc.lineAt(this.view.viewport.from).number;
      const vpLineBottom = state.doc.lineAt(this.view.viewport.to).number;
      const vpLineCount = vpLineBottom - vpLineTop;
      const vpScroll = vpLineTop / (state.doc.lines - vpLineCount);

      const { SizeRatio, PixelMultiplier } = Scale;
      const mmLineCount = vpLineCount * SizeRatio * PixelMultiplier;
      const mmLineRatio = vpScroll * mmLineCount;

      const mmLineTop = Math.max(1, Math.floor(vpLineTop - mmLineRatio));
      const mmLineBottom = Math.min(
        vpLineBottom + Math.floor(mmLineCount - mmLineRatio),
        state.doc.lines
      );
      const mmTo = state.doc.line(mmLineBottom).to

      /* Highlight parsed sections of the document, and store the text and tags for each line */
      const highlighter: Highlighter = {
        style: (tags) => highlightingFor(state, tags),
      };

      let highlights: Array<{ from: number; to: number; tags: string }> = [];

      // Highlight the in-view lines synchronously
      highlightTree(
        tree,
        highlighter,
        (from, to, tags) => {
          highlights.push({ from, to, tags });
        },
        state.doc.line(mmLineTop).from,
        state.doc.line(mmLineBottom).to
      );

      // Update the map
      this.updateMap(state, highlights, deadline);

      // Force parsing the rest of the mm in an idle callback
      const parseCallback = (deadline?: IdleDeadline) => {
        // Force the parsing till the bottom of the mmView
        // but only within the time allotted by the idle callback
        if (forceParsing(view, mmTo, deadline?.timeRemaining())) {
          this._parseCallbackId = undefined;
        } else {
          this._parseCallbackId = this.scheduleIdleCallback(parseCallback);
        }
      }
      // Schedule callback with aggressive timeout to ensure that parsing of
      // text within the mini-map happens promptly
      this._parseCallbackId = this.scheduleIdleCallback(parseCallback, { timeout: 0 })

      // Highlight the entire tree in an idle callback
      highlights = [];
      const highlightingCallback = (deadline?: IdleDeadline) => {
        highlightTree(tree, highlighter, (from, to, tags) => {
          highlights.push({ from, to, tags });
        });
        this.updateMap(state, highlights, deadline);
        this._highlightingCallbackId = undefined;
      };
      this._highlightingCallbackId = this.scheduleIdleCallback(highlightingCallback)
    }
  }

  private scheduleIdleCallback(callback: (deadline?: IdleDeadline) => void, options?: IdleRequestOptions): number {
    return typeof window.requestIdleCallback !== "undefined"
      ? requestIdleCallback(callback, options)
      : setTimeout(callback);
  }

  private cancelScheduledIdleCallback(id?: number) {
    if (id !== undefined && id === null) {
      typeof window.requestIdleCallback !== "undefined"
        ? cancelIdleCallback(id)
        : clearTimeout(id);
    }
  }

  private updateMap(
    state: EditorState,
    highlights: Array<{ from: number; to: number; tags: string }>,
    deadline?: IdleDeadline // If passed a deadline, then updateMap will be called in an idle callback
  ) {
    if (this._updateMapCallbackId) {
      this.cancelScheduledIdleCallback(this._updateMapCallbackId);
    }

    const docToString = state.doc.toString();
    const highlightsIterator = highlights.values();
    let highlightPtr = highlightsIterator.next();
    let startLine = 0;

    const updateMapCallback = (deadline?: IdleDeadline) => {
      for (const [index, line] of state.field(LinesState).slice(startLine).entries()) {
        const spans: Array<TagSpan> = [];

        for (const span of line) {
          // Skip if it's a 0-length span
          if (span.from === span.to) {
            continue;
          }

          // Append a placeholder for a folded span
          if (span.folded) {
            spans.push({ text: "…", tags: "" });
            continue;
          }

          let position = span.from;
          while (!highlightPtr.done && highlightPtr.value.from < span.to) {
            const { from, to, tags } = highlightPtr.value;

            // Iterate until our highlight is over the current span
            if (to < position) {
              highlightPtr = highlightsIterator.next();
              continue;
            }

            // Append unstyled text before the highlight begins
            if (from > position) {
              spans.push({ text: docToString.slice(position, from), tags: "" });
            }

            // A highlight may start before and extend beyond the current span
            const start = Math.max(from, span.from);
            const end = Math.min(to, span.to);

            // Append the highlighted text
            spans.push({ text: docToString.slice(start, end), tags });
            position = end;

            // If the highlight continues beyond this span, break from this loop
            if (to > end) {
              break;
            }

            // Otherwise, move to the next highlight
            highlightPtr = highlightsIterator.next();
          }

          // If there are remaining spans that did not get highlighted, append them unstyled
          if (position !== span.to) {
            spans.push({
              text: docToString.slice(position, span.to),
              tags: "",
            });
          }
        }

        // Lines are indexed beginning at 1 instead of 0
        const lineNumber = startLine + index + 1;
        this.map.set(lineNumber, spans);

        // If we've run out of time. Break the loop and schedule a continuation
        // later
        if (deadline && deadline?.timeRemaining() <= 0) {
          startLine += index;
          this._updateMapCallbackId = this.scheduleIdleCallback(updateMapCallback,
            { timeout: deadline.didTimeout ? 0 : undefined });
          return;
        }
        this._updateMapCallbackId = undefined;
      }
    }

    if (!deadline) {
      // If not called with a deadline, then do a blocking update
      updateMapCallback();
    } else {
      // Otherwise perform an async update
      this._updateMapCallbackId = this.scheduleIdleCallback(updateMapCallback,
        { timeout: deadline.didTimeout ? 0 : undefined });
    }
  }

  public measure(context: CanvasRenderingContext2D): {
    charWidth: number;
    lineHeight: number;
  } {
    const { color, font, lineHeight } = this.getFontInfo("");

    context.textBaseline = "ideographic";
    context.fillStyle = color;
    context.font = font;

    return {
      charWidth: context.measureText("_").width,
      lineHeight: lineHeight,
    };
  }

  public beforeDraw() {
    this._fontInfoMap.clear(); // TODO: Confirm this worked for theme changes or get rid of it because it's slow
  }

  public drawLine(ctx: DrawContext, lineNumber: number) {
    const line = this.get(lineNumber);
    if (!line) {
      return;
    }

    let { context, charWidth, lineHeight, offsetX, offsetY } = ctx;

    let prevInfo: FontInfo | undefined;
    context.textBaseline = "ideographic";

    for (const span of line) {
      const info = this.getFontInfo(span.tags);

      if (!prevInfo || prevInfo.color !== info.color) {
        context.fillStyle = info.color;
      }

      if (!prevInfo || prevInfo.font !== info.font) {
        context.font = info.font;
      }

      prevInfo = info;

      lineHeight = Math.max(lineHeight, info.lineHeight);

      switch (this._displayText) {
        case "characters": {
          // TODO: `fillText` takes up the majority of profiling time in `render`
          // Try speeding it up with `drawImage`
          // https://stackoverflow.com/questions/8237030/html5-canvas-faster-filltext-vs-drawimage/8237081

          context.fillText(span.text, offsetX, offsetY + lineHeight);
          offsetX += span.text.length * charWidth;
          break;
        }

        case "blocks": {
          const nonWhitespace = /\S+/g;
          let start: RegExpExecArray | null;
          while ((start = nonWhitespace.exec(span.text)) !== null) {
            const startX = offsetX + start.index * charWidth;
            let width = (nonWhitespace.lastIndex - start.index) * charWidth;

            // Reached the edge of the minimap
            if (startX > context.canvas.width) {
              break;
            }

            // Limit width to edge of minimap
            if (startX + width > context.canvas.width) {
              width = context.canvas.width - startX;
            }

            // Scaled 2px buffer between lines
            const yBuffer = 2 / Scale.SizeRatio;
            const height = lineHeight - yBuffer;

            context.fillStyle = info.color;
            context.globalAlpha = 0.65; // Make the blocks a bit faded
            context.beginPath();
            context.rect(startX, offsetY, width, height);
            context.fill();
          }

          offsetX += span.text.length * charWidth;
          break;
        }
      }
    }
  }

  private getFontInfo(tags: string): FontInfo {
    const cached = this._fontInfoMap.get(tags);
    if (cached) {
      return cached;
    }

    // Create a mock token wrapped in a cm-line
    const mockToken = crelt("span", { class: tags });
    const mockLine = crelt(
      "div",
      { class: "cm-line", style: "display: none" },
      mockToken
    );
    this.view.contentDOM.appendChild(mockLine);

    // Get style information and store it
    const style = window.getComputedStyle(mockToken);
    const lineHeight = parseFloat(style.lineHeight) / Scale.SizeRatio;
    const result = {
      color: style.color,
      font: `${style.fontStyle} ${style.fontWeight} ${lineHeight}px ${style.fontFamily}`,
      lineHeight,
    };
    this._fontInfoMap.set(tags, result);

    // Clean up and return
    this.view.contentDOM.removeChild(mockLine);
    return result;
  }

  private themeChanged(): boolean {
    const previous = this._themeClasses;
    const now = new Set(this.view.dom.classList.values());
    this._themeClasses = now;

    if (!previous) {
      return true;
    }

    // Ignore certain classes being added/removed
    previous.delete("cm-focused");
    now.delete("cm-focused");

    if (previous.size !== now.size) {
      return true;
    }

    let containsAll = true;
    previous.forEach((theme) => {
      if (!now.has(theme)) {
        containsAll = false;
      }
    });

    return !containsAll;
  }
}

export function text(view: EditorView): TextState {
  return new TextState(view);
}
