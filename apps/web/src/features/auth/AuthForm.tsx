import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { AuthSessionResponse } from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';

type Mode = 'login' | 'register';

/** Form dùng chung cho đăng nhập và đăng ký; thành công thì lưu phiên + CSRF token rồi vào ứng dụng. */
export function AuthForm({ mode }: { mode: Mode }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api.post<AuthSessionResponse>(
        mode === 'login' ? '/auth/login' : '/auth/register',
        mode === 'login' ? { email, password } : { email, password, displayName },
      ),
    onSuccess: (session) => {
      api.setCsrfToken(session.csrfToken);
      queryClient.setQueryData(queryKeys.me, session);
      navigate('/', { replace: true });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit.mutate();
  };

  const title = mode === 'login' ? t('auth.login.title') : t('auth.register.title');

  return (
    <main className="auth">
      <form onSubmit={onSubmit} className="card" aria-labelledby="auth-title">
        <h1 id="auth-title">{title}</h1>
        {mode === 'register' && (
          <label>
            {t('auth.displayName')}
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={80}
              autoComplete="name"
            />
          </label>
        )}
        <label>
          {t('auth.email')}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          {t('auth.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === 'register' ? 8 : 1}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {submit.isError && (
          <p role="alert" className="error">
            {describeError(submit.error)}
          </p>
        )}
        <button type="submit" disabled={submit.isPending}>
          {mode === 'login' ? t('auth.login.submit') : t('auth.register.submit')}
        </button>
        {mode === 'login' ? (
          <Link to="/register">{t('auth.login.toRegister')}</Link>
        ) : (
          <Link to="/login">{t('auth.register.toLogin')}</Link>
        )}
      </form>
    </main>
  );
}
