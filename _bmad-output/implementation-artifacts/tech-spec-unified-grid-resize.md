---
title: '统一网格拖拽缩放与四向放置'
slug: 'unified-grid-resize'
created: '2026-03-09'
status: 'done'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['Vanilla JS', 'CSS Grid']
files_to_modify:
  - 'src/multi_iterm2_manager/static/app.js'
  - 'src/multi_iterm2_manager/static/styles.css'
code_patterns:
  - 'localStorage 持久化视图状态'
  - '卡片拖拽 + 边缘命中预览'
  - 'CSS Grid 动态 track 比例'
test_patterns:
  - 'Playwright 本地页面交互验证'
---

# Tech-Spec: 统一网格拖拽缩放与四向放置

## Overview

### Problem Statement
现有页面把“网格布局”和“Split 实验布局”分成两套模式，用户需要记忆模式差异；同时普通网格无法直接拖动中线调整宽高。

### Solution
统一保留网格布局作为唯一布局模式，在网格中直接支持两类交互：
1. 拖动横/竖边界线调整全局行列比例
2. 拖动终端卡片到目标卡片的上/下/左/右边缘进行重排

### Scope

**In Scope:**
- 去除模式切换入口
- 网格比例拖拽
- 四向拖放重排
- 比例持久化与重置

**Out of Scope:**
- 服务端布局持久化
- 真实 iTerm 窗口物理尺寸同步
- 更复杂的任意嵌套 split tree

## Implementation Notes

- 比例状态保存在 `gridTrackRatios`，按 `列x行` 维度分别记忆
- 水平/垂直拖拽通过覆盖层按钮实现，不影响卡片主体交互
- 卡片放置继续复用原有边缘命中与预览样式，但结果改为更新 `orderedTerminalIds`
- 工具栏统一文案为“统一网格模式”

## Acceptance Criteria

- 4 宫格下可拖动纵向分隔线，左列变窄时右列同步变宽
- 4 宫格下可拖动横向分隔线，上行变高时下行同步变矮
- 拖动卡片到目标卡片边缘后，顺序按方向重排
- 刷新页面后，网格比例仍保留
- 页面不再暴露 split/grid 双模式切换
