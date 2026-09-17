import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import './Editor.css'

interface EditorProps {
  content: unknown
  onUpdate: (content: unknown) => void
}

export function Editor({ content, onUpdate }: EditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: content as object | undefined,
    onUpdate: ({ editor: e }) => onUpdate(e.getJSON()),
  })

  // 外部内容变化（同步覆盖）时更新编辑器。编辑器聚焦（正在输入/IME 组合中）时
  // 不覆盖，失焦时再对齐，避免打字被回滚、光标跳动和输入法中断。
  useEffect(() => {
    if (!editor) return
    const apply = () => {
      const current = JSON.stringify(editor.getJSON())
      const next = JSON.stringify(content ?? {})
      if (current !== next && !editor.isFocused) {
        editor.commands.setContent(content as object)
      }
    }
    apply()
    editor.on('blur', apply)
    return () => {
      editor.off('blur', apply)
    }
  }, [editor, content])

  return (
    <div className="editor-body">
      <EditorContent editor={editor} />
    </div>
  )
}
