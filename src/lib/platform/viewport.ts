/**
 * ソフトキーボード表示時に visualViewport の高さに合わせてアプリ領域をリサイズする。
 * iOS でこれをやらないとエディタのツールバーがキーボードの裏に隠れる。
 */
export function trackViewport() {
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
    if (vv) document.documentElement.style.setProperty('--vv-offset', `${vv.offsetTop}px`);
  };
  apply();
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
}
