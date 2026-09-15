/**
 * 从 assets/icon.svg 生成多尺寸 PNG 与 Windows ICO。
 * 依赖（隔离运行时安装）：@resvg/resvg-js、png-to-ico
 * 运行：NODE_PATH=<workspace>/node_modules node scripts/gen-icon.cjs
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const pngToIco = require('png-to-ico').default || require('png-to-ico').imagesToIco;

const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const OUT = path.join(ROOT, 'assets');

function render(size) {
  const resvg = new Resvg(fs.readFileSync(SVG, 'utf8'), {
    fitTo: { mode: 'width', value: size },
  });
  return resvg.render().asPng();
}

const ICO_SIZES = [16, 32, 48, 256];

function main() {
  // 主 PNG（512，供 BrowserWindow / 文档使用）
  const master = render(512);
  fs.writeFileSync(path.join(OUT, 'icon.png'), master);
  console.log('wrote icon.png (512)');

  // 各尺寸 PNG（便于调试与多平台复用）
  for (const s of ICO_SIZES) {
    fs.writeFileSync(path.join(OUT, `icon-${s}.png`), render(s));
    console.log(`wrote icon-${s}.png`);
  }

  // Windows 多尺寸 ICO
  const bufs = ICO_SIZES.map((s) => render(s));
  return pngToIco(bufs).then((ico) => {
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
    console.log('wrote icon.ico (16/32/48/256)');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
