// 圖示統一出口：品牌功能圖示與 lucide-react 共用既有介面
import React from 'react'
import logoUrl from '../../../../resources/icon.png'
import {
  ListVideo,
  Search,
  Star,
  Plus,
  FolderInput,
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
  Menu,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  FilePlus2,
  Save,
  Check,
  Copy,
  Globe
} from 'lucide-react'

export {
  ListVideo,
  Search,
  Star,
  Plus,
  FolderInput,
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
  Menu,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  FilePlus2,
  Save,
  Check,
  Copy,
  Globe
}

export { LayoutGrid, Film, Video, AnalysisQueue, Keyboard, SlidersHorizontal, Sparkles, Download } from './primary'

/** 簡化版探路者品牌頭像；側欄已有導覽標籤，圖像僅作裝飾。 */
export function LogoMark(props: { className?: string }): JSX.Element {
  return <img className={props.className} src={logoUrl} alt="" aria-hidden="true" draggable={false} />
}
