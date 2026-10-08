-- The tier view, about 0.8 s down to about 26 ms, 2026-10-08. Definitions only:
-- no table, column or row changes, and every view the app reads keeps its
-- columns and types.
--
-- Why it was slow:
-- 1. nb_v_account_tier joined nb_v_fit_metrics, then joined
--    nb_v_account_potential, which joined nb_v_fit_metrics again. The per-owner
--    medians and the fit for every open account ran twice per read.
-- 2. The scoring config (nb_score_configs.weights) is a 14 KB jsonb stored
--    compressed out of line. Each "weights -> ..." in a per-account expression
--    unpacked all of it again, a dozen or more times per account: about 0.5 s of
--    the 0.8 s.
--
-- What changes:
-- 1. nb_v_fit_metrics reads its four weights once (w AS MATERIALIZED).
-- 2. New nb_v_account_grade_basis: one row per account with the fit metrics
--    joined once and the grade computed once, reading the config's three
--    sections once. nb_v_account_potential and nb_v_account_tier become thin
--    selects over it, so the grade rule still lives in one place.
--
-- Proof, run on production before applying (one transaction, rolled back):
-- old and new output compared with EXCEPT ALL both ways over all rows, zero
-- rows different for nb_v_fit_metrics (768), nb_v_account_potential (826),
-- nb_v_account_tier (826), nb_v_cadence_due (569) and nb_v_pipeline_stale (0).
--
-- Rollback: run the three old definitions below, in order (the fit metrics
-- first, then potential, then tier), then drop view nb_v_account_grade_basis.
--
-- create or replace view public.nb_v_fit_metrics as
--  WITH cfg AS (
--          SELECT nb_score_configs.weights
--            FROM nb_score_configs
--           ORDER BY nb_score_configs.applied_at DESC
--          LIMIT 1
--         ), raw AS (
--          SELECT nb_accounts.id AS account_id,
--             nb_accounts.hubspot_owner_id,
--             nb_accounts.shelf_units AS s,
--             nb_accounts.employee_count::numeric AS q,
--             nb_accounts.stores_per_decision_maker AS d
--            FROM nb_accounts
--           WHERE nb_accounts.closed_at IS NULL
--         ), med AS (
--          SELECT raw.hubspot_owner_id,
--             percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (raw.s::double precision)) AS ms,
--             percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (raw.q::double precision)) AS mq,
--             percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (raw.d::double precision)) AS md
--            FROM raw
--           GROUP BY raw.hubspot_owner_id
--         ), norm AS (
--          SELECT r.account_id,
--                 CASE
--                     WHEN r.s IS NOT NULL AND m.ms > 0::double precision THEN LEAST(100::double precision, GREATEST(0::double precision, (50::numeric * r.s)::double precision / m.ms))
--                     ELSE NULL::double precision
--                 END AS ns,
--                 CASE
--                     WHEN r.q IS NOT NULL AND m.mq > 0::double precision THEN LEAST(100::double precision, GREATEST(0::double precision, (50::numeric * r.q)::double precision / m.mq))
--                     ELSE NULL::double precision
--                 END AS nq,
--                 CASE
--                     WHEN r.d IS NOT NULL AND m.md > 0::double precision THEN LEAST(100::double precision, GREATEST(0::double precision, (50::numeric * r.d)::double precision / m.md))
--                     ELSE NULL::double precision
--                 END AS nd
--            FROM raw r
--              LEFT JOIN med m ON NOT m.hubspot_owner_id IS DISTINCT FROM r.hubspot_owner_id
--         ), w AS (
--          SELECT (((cfg.weights -> 'fit'::text) -> 'weights'::text) ->> 'shelves'::text)::numeric AS ws,
--             (((cfg.weights -> 'fit'::text) -> 'weights'::text) ->> 'supp_staff'::text)::numeric AS wq,
--             (((cfg.weights -> 'fit'::text) -> 'weights'::text) ->> 'stores_per_dm'::text)::numeric AS wd,
--             ((cfg.weights -> 'fit'::text) ->> 'prior'::text)::numeric AS prior
--            FROM cfg
--         )
--  SELECT n.account_id,
--         CASE
--             WHEN k.kw = 0::numeric THEN w.prior::double precision
--             ELSE (COALESCE(n.ns * w.ws::double precision, 0::double precision) + COALESCE(n.nq * w.wq::double precision, 0::double precision) + COALESCE(n.nd * w.wd::double precision, 0::double precision)) / k.kw::double precision
--         END::numeric(6,2) AS fit,
--     (k.kw / (w.ws + w.wq + w.wd))::numeric(5,3) AS fit_confidence,
--     (n.ns IS NOT NULL)::integer + (n.nq IS NOT NULL)::integer + (n.nd IS NOT NULL)::integer AS inputs_known,
--     3 AS inputs_total,
--     n.ns IS NOT NULL OR n.nq IS NOT NULL AS core_known
--    FROM norm n
--      CROSS JOIN w
--      CROSS JOIN LATERAL ( SELECT
--                 CASE
--                     WHEN n.ns IS NOT NULL THEN w.ws
--                     ELSE 0::numeric
--                 END +
--                 CASE
--                     WHEN n.nq IS NOT NULL THEN w.wq
--                     ELSE 0::numeric
--                 END +
--                 CASE
--                     WHEN n.nd IS NOT NULL THEN w.wd
--                     ELSE 0::numeric
--                 END AS kw) k;
--
-- create or replace view public.nb_v_account_potential as
--  WITH cfg AS (
--          SELECT nb_score_configs.weights
--            FROM nb_score_configs
--           ORDER BY nb_score_configs.applied_at DESC
--          LIMIT 1
--         )
--  SELECT a.id AS account_id,
--     a.name,
--     a.store_type,
--     a.retail_mode,
--     a.locations_count,
--     a.lifetime_revenue,
--     COALESCE(p.value, 0::numeric) AS potential,
--     COALESCE(p.confidence, 0::numeric) AS potential_confidence,
--     p.inputs_known AS potential_inputs_known,
--     p.inputs_total AS potential_inputs_total,
--     a.origin,
--     a.potential_hq AS potential_label,
--     COALESCE(a.potential_juan,
--         CASE
--             WHEN NOT COALESCE(fm.core_known, false) THEN NULL::text
--             WHEN fm.fit >= ((((cfg.weights -> 'tiers'::text) -> 'metric_bands'::text) ->> 'A'::text)::numeric) THEN 'A'::text
--             WHEN fm.fit >= ((((cfg.weights -> 'tiers'::text) -> 'metric_bands'::text) ->> 'B'::text)::numeric) THEN 'B'::text
--             WHEN fm.fit >= ((((cfg.weights -> 'tiers'::text) -> 'metric_bands'::text) ->> 'C'::text)::numeric) THEN 'C'::text
--             ELSE 'D'::text
--         END,
--         CASE
--             WHEN a.lifetime_revenue > 0::numeric AND a.lifetime_revenue <= ((((cfg.weights -> 'tiers'::text) -> 'e_rule'::text) ->> 'small_lifetime_max'::text)::numeric) THEN 'E'::text
--             WHEN a.lifetime_revenue > ((((cfg.weights -> 'tiers'::text) -> 'e_rule'::text) ->> 'small_lifetime_max'::text)::numeric) AND a.lifetime_revenue < ((((cfg.weights -> 'tiers'::text) -> 'e_rule'::text) ->> 'mid_lifetime_max'::text)::numeric) AND a.last_order_at IS NOT NULL AND (CURRENT_DATE - a.last_order_at)::numeric >= (((((cfg.weights -> 'tiers'::text) -> 'e_rule'::text) ->> 'mid_silent_years_gte'::text)::numeric) * 365.25) THEN 'E'::text
--             WHEN a.lifetime_revenue >= ((((cfg.weights -> 'tiers'::text) -> 'e_rule'::text) ->> 'big_lifetime_min'::text)::numeric) AND a.last_order_at IS NOT NULL AND (CURRENT_DATE - a.last_order_at)::numeric >= (((((cfg.weights -> 'tiers'::text) -> 'e_rule'::text) ->> 'big_silent_months_gte'::text)::numeric) * 30::numeric) THEN
--             CASE
--                 WHEN a.lifetime_revenue >= ((((cfg.weights -> 'tiers'::text) -> 'lifetime_value_floor'::text) ->> 'high_gte'::text)::numeric) THEN ((cfg.weights -> 'tiers'::text) -> 'lifetime_value_floor'::text) ->> 'high_letter'::text
--                 WHEN a.lifetime_revenue >= ((((cfg.weights -> 'tiers'::text) -> 'lifetime_value_floor'::text) ->> 'mid_gte'::text)::numeric) THEN ((cfg.weights -> 'tiers'::text) -> 'lifetime_value_floor'::text) ->> 'mid_letter'::text
--                 ELSE ((cfg.weights -> 'tiers'::text) -> 'lifetime_value_floor'::text) ->> 'min_letter'::text
--             END
--             ELSE NULL::text
--         END, NULLIF(split_part(a.potential_hq, ' '::text, 1), ''::text),
--         CASE
--             WHEN COALESCE(p.confidence, 0::numeric) < (((cfg.weights -> 'tiers'::text) ->> 'confidence_floor'::text)::numeric) THEN NULL::text
--             WHEN p.value >= ((((cfg.weights -> 'potential'::text) -> 'bands'::text) ->> 'A'::text)::numeric) THEN 'A'::text
--             WHEN p.value >= ((((cfg.weights -> 'potential'::text) -> 'bands'::text) ->> 'B'::text)::numeric) THEN 'B'::text
--             WHEN p.value >= ((((cfg.weights -> 'potential'::text) -> 'bands'::text) ->> 'C'::text)::numeric) THEN 'C'::text
--             ELSE 'D'::text
--         END,
--         CASE
--             WHEN a.hubspot_company_id IS NOT NULL AND a.lifecycle = 'active'::text THEN 'D'::text
--             ELSE NULL::text
--         END) AS potential_grade
--    FROM nb_accounts a
--      LEFT JOIN nb_v_account_scores_current p ON p.account_id = a.id AND p.kind = 'potential'::nb_score_kind
--      LEFT JOIN nb_v_fit_metrics fm ON fm.account_id = a.id
--      CROSS JOIN cfg;
--
-- create or replace view public.nb_v_account_tier as
--  SELECT a.id AS account_id,
--     a.name,
--     a.lifecycle,
--     COALESCE(fm.fit, ((cfg.weights -> 'fit'::text) ->> 'prior'::text)::numeric, 50::numeric) AS fit,
--     COALESCE(fm.fit_confidence, 0::numeric) AS fit_confidence,
--     fm.inputs_known AS fit_inputs_known,
--     fm.inputs_total AS fit_inputs_total,
--     COALESCE(e.value, 0::numeric) AS engagement,
--     a.origin,
--     pot.potential_grade AS tier,
--     a.area,
--     a.hubspot_owner_id,
--     a.chain_excluded,
--     a.practice_excluded,
--     a.closed_at
--    FROM nb_accounts a
--      LEFT JOIN nb_v_fit_metrics fm ON fm.account_id = a.id
--      LEFT JOIN nb_v_account_scores_current e ON e.account_id = a.id AND e.kind = 'engagement'::nb_score_kind
--      LEFT JOIN nb_v_account_potential pot ON pot.account_id = a.id
--      CROSS JOIN ( SELECT nb_score_configs.weights
--            FROM nb_score_configs
--           ORDER BY nb_score_configs.applied_at DESC
--          LIMIT 1) cfg;

-- 1. The fit metrics. Same CTEs, but the four weights are read out of the
--    config once (MATERIALIZED) instead of once per account per reference.
create or replace view public.nb_v_fit_metrics as
 WITH cfg AS (
         SELECT nb_score_configs.weights
           FROM nb_score_configs
          ORDER BY nb_score_configs.applied_at DESC
         LIMIT 1
        ), raw AS (
         SELECT nb_accounts.id AS account_id,
            nb_accounts.hubspot_owner_id,
            nb_accounts.shelf_units AS s,
            nb_accounts.employee_count::numeric AS q,
            nb_accounts.stores_per_decision_maker AS d
           FROM nb_accounts
          WHERE nb_accounts.closed_at IS NULL
        ), med AS (
         SELECT raw.hubspot_owner_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (raw.s::double precision)) AS ms,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (raw.q::double precision)) AS mq,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (raw.d::double precision)) AS md
           FROM raw
          GROUP BY raw.hubspot_owner_id
        ), norm AS (
         SELECT r.account_id,
                CASE
                    WHEN r.s IS NOT NULL AND m.ms > 0::double precision THEN LEAST(100::double precision, GREATEST(0::double precision, (50::numeric * r.s)::double precision / m.ms))
                    ELSE NULL::double precision
                END AS ns,
                CASE
                    WHEN r.q IS NOT NULL AND m.mq > 0::double precision THEN LEAST(100::double precision, GREATEST(0::double precision, (50::numeric * r.q)::double precision / m.mq))
                    ELSE NULL::double precision
                END AS nq,
                CASE
                    WHEN r.d IS NOT NULL AND m.md > 0::double precision THEN LEAST(100::double precision, GREATEST(0::double precision, (50::numeric * r.d)::double precision / m.md))
                    ELSE NULL::double precision
                END AS nd
           FROM raw r
             LEFT JOIN med m ON NOT m.hubspot_owner_id IS DISTINCT FROM r.hubspot_owner_id
        ), w AS MATERIALIZED (
         SELECT (((cfg.weights -> 'fit'::text) -> 'weights'::text) ->> 'shelves'::text)::numeric AS ws,
            (((cfg.weights -> 'fit'::text) -> 'weights'::text) ->> 'supp_staff'::text)::numeric AS wq,
            (((cfg.weights -> 'fit'::text) -> 'weights'::text) ->> 'stores_per_dm'::text)::numeric AS wd,
            ((cfg.weights -> 'fit'::text) ->> 'prior'::text)::numeric AS prior
           FROM cfg
        )
 SELECT n.account_id,
        CASE
            WHEN k.kw = 0::numeric THEN w.prior::double precision
            ELSE (COALESCE(n.ns * w.ws::double precision, 0::double precision) + COALESCE(n.nq * w.wq::double precision, 0::double precision) + COALESCE(n.nd * w.wd::double precision, 0::double precision)) / k.kw::double precision
        END::numeric(6,2) AS fit,
    (k.kw / (w.ws + w.wq + w.wd))::numeric(5,3) AS fit_confidence,
    (n.ns IS NOT NULL)::integer + (n.nq IS NOT NULL)::integer + (n.nd IS NOT NULL)::integer AS inputs_known,
    3 AS inputs_total,
    n.ns IS NOT NULL OR n.nq IS NOT NULL AS core_known
   FROM norm n
     CROSS JOIN w
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN n.ns IS NOT NULL THEN w.ws
                    ELSE 0::numeric
                END +
                CASE
                    WHEN n.nq IS NOT NULL THEN w.wq
                    ELSE 0::numeric
                END +
                CASE
                    WHEN n.nd IS NOT NULL THEN w.wd
                    ELSE 0::numeric
                END AS kw) k;

-- 2. One row per account with the fit metrics joined once and the grade
--    computed once. The potential and tier views below both read it, so the
--    grade rule lives in one place and the tier view no longer runs the fit
--    metrics a second time through the potential view. The config's three
--    sections are pulled out once (MATERIALIZED), so each account reads a few
--    KB in memory instead of unpacking the whole 14 KB config per lookup.
create or replace view public.nb_v_account_grade_basis as
 WITH cfg AS MATERIALIZED (
         SELECT nb_score_configs.weights -> 'tiers'::text AS tiers,
            nb_score_configs.weights -> 'potential'::text AS potential,
            nb_score_configs.weights -> 'fit'::text AS fit
           FROM nb_score_configs
          ORDER BY nb_score_configs.applied_at DESC
         LIMIT 1
        )
 SELECT a.id AS account_id,
    a.name,
    a.store_type,
    a.retail_mode,
    a.locations_count,
    a.lifetime_revenue,
    COALESCE(p.value, 0::numeric) AS potential,
    COALESCE(p.confidence, 0::numeric) AS potential_confidence,
    p.inputs_known AS potential_inputs_known,
    p.inputs_total AS potential_inputs_total,
    a.origin,
    a.potential_hq AS potential_label,
    COALESCE(a.potential_juan,
        CASE
            WHEN NOT COALESCE(fm.core_known, false) THEN NULL::text
            WHEN fm.fit >= (((cfg.tiers -> 'metric_bands'::text) ->> 'A'::text)::numeric) THEN 'A'::text
            WHEN fm.fit >= (((cfg.tiers -> 'metric_bands'::text) ->> 'B'::text)::numeric) THEN 'B'::text
            WHEN fm.fit >= (((cfg.tiers -> 'metric_bands'::text) ->> 'C'::text)::numeric) THEN 'C'::text
            ELSE 'D'::text
        END,
        CASE
            WHEN a.lifetime_revenue > 0::numeric AND a.lifetime_revenue <= (((cfg.tiers -> 'e_rule'::text) ->> 'small_lifetime_max'::text)::numeric) THEN 'E'::text
            WHEN a.lifetime_revenue > (((cfg.tiers -> 'e_rule'::text) ->> 'small_lifetime_max'::text)::numeric) AND a.lifetime_revenue < (((cfg.tiers -> 'e_rule'::text) ->> 'mid_lifetime_max'::text)::numeric) AND a.last_order_at IS NOT NULL AND (CURRENT_DATE - a.last_order_at)::numeric >= ((((cfg.tiers -> 'e_rule'::text) ->> 'mid_silent_years_gte'::text)::numeric) * 365.25) THEN 'E'::text
            WHEN a.lifetime_revenue >= (((cfg.tiers -> 'e_rule'::text) ->> 'big_lifetime_min'::text)::numeric) AND a.last_order_at IS NOT NULL AND (CURRENT_DATE - a.last_order_at)::numeric >= ((((cfg.tiers -> 'e_rule'::text) ->> 'big_silent_months_gte'::text)::numeric) * 30::numeric) THEN
            CASE
                WHEN a.lifetime_revenue >= (((cfg.tiers -> 'lifetime_value_floor'::text) ->> 'high_gte'::text)::numeric) THEN (cfg.tiers -> 'lifetime_value_floor'::text) ->> 'high_letter'::text
                WHEN a.lifetime_revenue >= (((cfg.tiers -> 'lifetime_value_floor'::text) ->> 'mid_gte'::text)::numeric) THEN (cfg.tiers -> 'lifetime_value_floor'::text) ->> 'mid_letter'::text
                ELSE (cfg.tiers -> 'lifetime_value_floor'::text) ->> 'min_letter'::text
            END
            ELSE NULL::text
        END, NULLIF(split_part(a.potential_hq, ' '::text, 1), ''::text),
        CASE
            WHEN COALESCE(p.confidence, 0::numeric) < ((cfg.tiers ->> 'confidence_floor'::text)::numeric) THEN NULL::text
            WHEN p.value >= (((cfg.potential -> 'bands'::text) ->> 'A'::text)::numeric) THEN 'A'::text
            WHEN p.value >= (((cfg.potential -> 'bands'::text) ->> 'B'::text)::numeric) THEN 'B'::text
            WHEN p.value >= (((cfg.potential -> 'bands'::text) ->> 'C'::text)::numeric) THEN 'C'::text
            ELSE 'D'::text
        END,
        CASE
            WHEN a.hubspot_company_id IS NOT NULL AND a.lifecycle = 'active'::text THEN 'D'::text
            ELSE NULL::text
        END) AS potential_grade,
    COALESCE(fm.fit, (cfg.fit ->> 'prior'::text)::numeric, 50::numeric) AS fit,
    COALESCE(fm.fit_confidence, 0::numeric) AS fit_confidence,
    fm.inputs_known AS fit_inputs_known,
    fm.inputs_total AS fit_inputs_total,
    a.lifecycle,
    a.area,
    a.hubspot_owner_id,
    a.chain_excluded,
    a.practice_excluded,
    a.closed_at
   FROM nb_accounts a
     LEFT JOIN nb_v_account_scores_current p ON p.account_id = a.id AND p.kind = 'potential'::nb_score_kind
     LEFT JOIN nb_v_fit_metrics fm ON fm.account_id = a.id
     CROSS JOIN cfg;

-- Same grants as every nb_v_* view after 0007: no anon.
revoke all on public.nb_v_account_grade_basis from anon;

-- 3. The two views the app reads, same columns and types, now thin selects.
create or replace view public.nb_v_account_potential as
 SELECT b.account_id,
    b.name,
    b.store_type,
    b.retail_mode,
    b.locations_count,
    b.lifetime_revenue,
    b.potential,
    b.potential_confidence,
    b.potential_inputs_known,
    b.potential_inputs_total,
    b.origin,
    b.potential_label,
    b.potential_grade
   FROM nb_v_account_grade_basis b;

create or replace view public.nb_v_account_tier as
 SELECT b.account_id,
    b.name,
    b.lifecycle,
    b.fit,
    b.fit_confidence,
    b.fit_inputs_known,
    b.fit_inputs_total,
    COALESCE(e.value, 0::numeric) AS engagement,
    b.origin,
    b.potential_grade AS tier,
    b.area,
    b.hubspot_owner_id,
    b.chain_excluded,
    b.practice_excluded,
    b.closed_at
   FROM nb_v_account_grade_basis b
     LEFT JOIN nb_v_account_scores_current e ON e.account_id = b.account_id AND e.kind = 'engagement'::nb_score_kind;
