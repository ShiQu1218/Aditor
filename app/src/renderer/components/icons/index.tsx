// 圖示統一出口：集中自 lucide-react 匯入，避免各處散落
import React from 'react'
import {
  LayoutGrid,
  Film,
  Keyboard,
  SlidersHorizontal,
  ListVideo,
  Search,
  Star,
  Plus,
  FolderInput,
  Sparkles,
  MoreHorizontal,
  AlertTriangle,
  RefreshCw,
  Trash2,
  ImageOff,
  X,
  FolderOpen,
  Loader2,
  ChevronDown,
  ChevronLeft,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Scissors,
  Download,
  Menu,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  FilePlus2,
  Save,
  Check
} from 'lucide-react'

export {
  LayoutGrid,
  Film,
  Keyboard,
  SlidersHorizontal,
  ListVideo,
  Search,
  Star,
  Plus,
  FolderInput,
  Sparkles,
  MoreHorizontal,
  AlertTriangle,
  RefreshCw,
  Trash2,
  ImageOff,
  X,
  FolderOpen,
  Loader2,
  ChevronDown,
  ChevronLeft,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Scissors,
  Download,
  Menu,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  FilePlus2,
  Save,
  Check
}

/** 品牌 logo（六角形＋十字），顏色跟隨 currentColor */
export function LogoMark(props: { className?: string }): JSX.Element {
  return (
    <svg className={props.className} viewBox="0 0 32 32" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M16 2l12 7v14l-12 7-12-7V9z" />
      <path d="M16 9v14 M9 16h14" />
    </svg>
  )
}
