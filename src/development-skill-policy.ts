/** Legacy clients read shared HOME; allow them when using the production account's synchronized key. */
export function isSkillDisabledInDevelopment(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.HEDGEHOG_DEV_ENDPOINTS === '1'
    && (env.HEDGEHOG_DEV_SKILLS_MODE === 'off'
      || (env.HEDGEHOG_CIWEI_AI_BASE_URL?.replace(/\/+$/, '') !== 'https://api.ciweiai.com/api'
        && ['hedgehog-company-index-data', 'hedgehog-macro-industry-data', 'hedgehog-news-reports'].includes(name)));
}
