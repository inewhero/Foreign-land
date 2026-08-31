data {
  int<lower=1> N; int<lower=1> S; int<lower=1> J; int<lower=1> W; int<lower=4> G;
  array[N] int<lower=1, upper=S> subj;
  array[N] int<lower=1, upper=J> sess;
  array[N] int<lower=1, upper=W> wave;
  array[N] int<lower=0, upper=1> group;
  array[N] int<lower=1, upper=G> game;
  array[N] int<lower=-1, upper=1> regime;
  vector[N] social_mean; vector[N] social_contrast; vector[N] imitation;
  vector[N] self_value; vector[N] previous_choice; vector[N] trial_position;
  array[N] int<lower=0, upper=1> y;
  array[J] int<lower=1, upper=S> session_subject;
  array[J] int<lower=1, upper=W> session_wave;
  array[J] int<lower=0, upper=1> session_group;
  array[J] int<lower=0, upper=J> previous_session;
}
parameters {
  vector[6] phenotype_mean;
  vector<lower=0>[6] phenotype_sd;
  cholesky_factor_corr[6] phenotype_cholesky;
  matrix[6, S] subject_z;
  vector<lower=0>[2] state_sd;
  vector<lower=-0.95, upper=0.95>[2] state_phi;
  matrix[2, J] state_innovation;
  vector[G - 1] game_intercept;
  vector[G - 1] game_social;
  real regime_social;
  real regime_intercept; real order_effect;
  vector[W - 1] wave_svs;
  vector[W - 1] group_wave_svs;
}
transformed parameters {
  matrix[S, 6] subject_effect = (diag_pre_multiply(phenotype_sd, phenotype_cholesky) * subject_z)';
  matrix[J, 2] session_state;
  for (j in 1:J) {
    if (previous_session[j] == 0) {
      session_state[j, 1] = state_sd[1] * state_innovation[1, j];
      session_state[j, 2] = state_sd[2] * state_innovation[2, j];
    } else {
      session_state[j, 1] = state_phi[1] * session_state[previous_session[j], 1] + state_sd[1] * state_innovation[1, j];
      session_state[j, 2] = state_phi[2] * session_state[previous_session[j], 2] + state_sd[2] * state_innovation[2, j];
    }
  }
}
model {
  phenotype_mean ~ normal(0, 0.5);
  phenotype_sd ~ normal(0, 0.5);
  phenotype_cholesky ~ lkj_corr_cholesky(2);
  to_vector(subject_z) ~ std_normal();
  state_sd ~ normal(0, 0.5);
  state_phi ~ normal(0, 0.35);
  to_vector(state_innovation) ~ std_normal();
  game_intercept ~ normal(0, 0.5);
  game_social ~ normal(0, 0.5);
  regime_social ~ normal(0, 0.5);
  regime_intercept ~ normal(0, 0.5); order_effect ~ normal(0, 0.5);
  wave_svs ~ normal(0, 0.5);
  group_wave_svs ~ normal(0, 0.5);
  for (n in 1:N) {
    int s = subj[n]; int j = sess[n];
    real svs = phenotype_mean[2] + subject_effect[s, 2] + session_state[j, 1];
    if (wave[n] > 1) svs += wave_svs[wave[n] - 1] + group[n] * group_wave_svs[wave[n] - 1];
    y[n] ~ bernoulli_logit(
      phenotype_mean[1] + subject_effect[s, 1]
      + (game[n] > 1 ? game_intercept[game[n] - 1] : 0)
      + regime_intercept * regime[n] + order_effect * trial_position[n]
      + (svs + (game[n] > 1 ? game_social[game[n] - 1] : 0) + regime_social * regime[n]) * social_mean[n]
      + (phenotype_mean[3] + subject_effect[s, 3]) * social_contrast[n]
      + (phenotype_mean[4] + subject_effect[s, 4]) * imitation[n]
      + (phenotype_mean[5] + subject_effect[s, 5] + session_state[j, 2]) * self_value[n]
      + (phenotype_mean[6] + subject_effect[s, 6]) * previous_choice[n]
    );
  }
}
generated quantities {
  vector[N] log_lik; vector[N] log_lik_no_social;
  for (n in 1:N) {
    int s = subj[n]; int j = sess[n];
    real svs = phenotype_mean[2] + subject_effect[s, 2] + session_state[j, 1];
    real eta_common = phenotype_mean[1] + subject_effect[s, 1]
      + (game[n] > 1 ? game_intercept[game[n] - 1] : 0)
      + regime_intercept * regime[n] + order_effect * trial_position[n]
      + (phenotype_mean[4] + subject_effect[s, 4]) * imitation[n]
      + (phenotype_mean[5] + subject_effect[s, 5] + session_state[j, 2]) * self_value[n]
      + (phenotype_mean[6] + subject_effect[s, 6]) * previous_choice[n];
    if (wave[n] > 1) svs += wave_svs[wave[n] - 1] + group[n] * group_wave_svs[wave[n] - 1];
    log_lik[n] = bernoulli_logit_lpmf(y[n] | eta_common
      + (svs + (game[n] > 1 ? game_social[game[n] - 1] : 0) + regime_social * regime[n]) * social_mean[n]
      + (phenotype_mean[3] + subject_effect[s, 3]) * social_contrast[n]);
    log_lik_no_social[n] = bernoulli_logit_lpmf(y[n] | eta_common);
  }
}
