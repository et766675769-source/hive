# 随机头像库（100 个完整头像）

这套库按参考图风格重新制作：黑白色调、块状发型、白色圆脸、极简点眼与短下颌线。每个文件都是一个可直接使用的完整头像 PNG，不再拆分脸和发型。

## 目录

- `avatars/avatar-001.png` ～ `avatars/avatar-100.png`：100 个独立头像，256×256，透明背景。
- `preview/avatar-catalog-100.png`：100 个头像的白底预览图。
- `manifest.json`：文件清单和运行时信息。
- `source/`：参考风格图集存档。

## 使用方式

随机生成头像时，在 `avatars` 目录中随机取一个文件即可：

```js
const id = String(Math.floor(Math.random() * 100) + 1).padStart(3, '0');
const avatar = `/avatars/avatar-${id}.png`;
```

头像已经是完整合成结果，不需要再匹配脸层、发型层，也不会出现图层错位。PNG 四角为透明像素，放在任意颜色背景上都可以直接使用。
