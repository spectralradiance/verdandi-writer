import { type Extension, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

class TitleWidget extends WidgetType {
  readonly title: string

  constructor(title: string) {
    super()
    this.title = title
  }

  eq(other: TitleWidget): boolean {
    return other.title === this.title
  }

  toDOM(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'cm-doc-title'
    element.textContent = this.title
    return element
  }

  ignoreEvent(): boolean {
    return true
  }
}

/**
 * The document's own title (its file name), shown above the first line and scrolling
 * with the text. It is not part of the text, so it never becomes a `#` heading.
 */
export function documentTitle(title: string): Extension {
  if (!title) return []
  const decorations = Decoration.set([Decoration.widget({ widget: new TitleWidget(title), block: true, side: -1 }).range(0)])
  return StateField.define<DecorationSet>({
    create: () => decorations,
    update: (value) => value,
    provide: (field) => EditorView.decorations.from(field),
  })
}
