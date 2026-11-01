import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'

test('rm variants', async () => {
  expect(classify('rm -rf build')).toEqual({ kind: 'rm', label: 'rm -rf', targets: ['build'] })
  expect(classify('rm -r a b')).toEqual({ kind: 'rm', label: 'rm -r', targets: ['a', 'b'] })
  expect(classify('rm -f x')).toEqual({ kind: 'rm', label: 'rm -f', targets: ['x'] })
  expect(classify('rm x')).toBe(null)
})

test('git variants', async () => {
  expect(classify('git reset --hard')?.kind).toBe('git-reset')
  const clean = classify('git clean -fdx')
  expect(clean?.kind).toBe('git-clean')
  expect(clean !== null && 'args' in clean ? clean.args : []).toContain('-fdx')
  expect(classify('git push -f')?.kind).toBe('git-push-force')
  expect(classify('git push --force-with-lease')?.kind).toBe('git-push-force')
  expect(classify('git push origin +main')?.kind).toBe('git-push-force')
  expect(classify('git checkout -- .')?.kind).toBe('git-checkout')
  expect(classify('git restore .')?.kind).toBe('git-checkout')
})

test('migrate variants', async () => {
  const toolOf = (command: string) => {
    const risk = classify(command)
    return risk?.kind === 'migrate' ? risk.tool : null
  }
  expect(toolOf('python manage.py migrate')).toBe('django')
  expect(toolOf('rails db:migrate')).toBe('rails')
  expect(toolOf('alembic upgrade head')).toBe('alembic')
  expect(toolOf('npx prisma migrate deploy')).toBe('prisma')
  expect(toolOf('./run migrate')).toBe('unknown')
})

test('harmless', async () => {
  expect(classify('ls -la')).toBe(null)
  expect(classify('git status')).toBe(null)
  expect(classify('git push')).toBe(null)
  expect(classify('echo rm -rf x')).toBe(null)
})

test('cd follows', async () => {
  expect(classify('cd build && rm -rf dist')).toEqual({
    kind: 'rm',
    label: 'rm -rf',
    targets: ['dist'],
    dir: 'build',
  })
  expect(classify('git -C sub reset --hard')?.dir).toBe('sub')
  const popped = classify('pushd a && popd && rm -rf b')
  expect(popped?.kind).toBe('rm')
  expect(popped !== null && 'dir' in popped).toBe(false)
})

test('subshell cd stays inside', async () => {
  const risk = classify('(cd x && ls); rm -rf y')
  expect(risk).toEqual({ kind: 'rm', label: 'rm -rf', targets: ['y'] })
  // 括号内的危险命令仍跟随括号内的 cd
  expect(classify('(cd x && rm -rf y); rm -rf z')?.dir).toBe('x')
})

test('cd dash', async () => {
  expect(classify('cd - && rm -rf y')?.dir).toBe('-')
})

test('prefixes', async () => {
  expect(classify('sudo rm -rf /tmp/x')?.kind).toBe('rm')
  expect(classify('sudo -u root rm -rf /tmp/x')?.kind).toBe('rm')
  expect(classify('env rm -rf x')?.kind).toBe('rm')
  expect(classify('nohup rm -rf x')?.kind).toBe('rm')
})

test('more forms from the original', async () => {
  expect(classify('git restore --staged .')).toBe(null)
  expect(classify('\\rm -rf x')?.kind).toBe('rm')
  expect(classify('nice -n 10 rm -rf x')?.kind).toBe('rm')
  expect(classify('git -c k=v reset --hard')?.kind).toBe('git-reset')
  expect(classify('(cd sub && rm -rf x) > log')?.dir).toBe('sub')
  expect(classify('rake db:migrate:status')).toBe(null)
})
