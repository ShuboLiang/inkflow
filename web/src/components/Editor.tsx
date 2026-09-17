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

  useEffect(() => {
    if (!editor) return
    const current = JSON.stringify(editor.getJSON())
    const next = JSON.stringify(content ?? {})
    if (current !== next) {
      editor.commands.setContent(content as object)
    }
  }, [editor, content])

  return (
    <div className="editor-body">
      <EditorContent editor={editor} />
    </div>
  )
}
