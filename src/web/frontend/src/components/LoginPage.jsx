import { useEffect, useState } from "react";

export default function LoginPage({ onLogin, loading, notice = "" }) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(notice);

  useEffect(() => {
    setError(notice);
  }, [notice]);

  const submit = async (event) => {
    event.preventDefault();
    if (!password || loading) return;
    setError("");
    const result = await onLogin(password);
    if (!result.ok) setError(result.error);
  };

  return (
    <main className="login-container">
      <section className="login-card">
        <div className="login-brand" aria-hidden="true">
          🌸
        </div>
        <h2>SakuraTG 配置面板</h2>
        <p>登录后管理角色扮演、短期历史与 NovelAI 绘图。</p>

        <form onSubmit={submit}>
          <div className="field-group">
            <label className="field-label" htmlFor="login-password">
              面板密码
            </label>
            <div className="secret-input-row">
              <input
                id="login-password"
                className="field-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError("");
                }}
                placeholder="请输入配置的面板密码"
                autoComplete="current-password"
                autoFocus
              />
              <button
                className="btn btn-secondary secret-action"
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
              >
                {showPassword ? "隐藏" : "显示"}
              </button>
            </div>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            className="btn btn-primary login-submit"
            type="submit"
            disabled={loading || !password}
          >
            {loading ? "验证中…" : "进入面板"}
          </button>
        </form>
      </section>
    </main>
  );
}
