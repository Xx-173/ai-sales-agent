# SalesClaw 图标

`logo-1024.png` 是 SalesClaw 的唯一源图标。Web、PWA 与 Electron 打包资源均基于它生成。

如需更新图标，替换该文件后执行：

```bash
node web/scripts/generate-icons.js
```

生成的 `icon-*.png`、`icon-512-maskable.png` 和 `apple-touch-icon-180.png` 会被 Web/PWA 使用；桌面端资源位于 `electron/assets/`。
