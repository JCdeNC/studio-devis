/* Studio Devis · mode hors connexion
 * Chargé par l'application installée (jcdenc.github.io/studio-devis), il remplace google.script.run :
 * - en ligne : chaque appel part vers Studio Devis (Apps Script, fonction appStudio_) ; ce qui est lu est gardé sur l'appareil ;
 * - hors connexion : les écrans s'affichent avec la dernière copie gardée ; frais, encaissements, agenda et To Do
 *   sont enregistrés sur l'appareil, visibles tout de suite, puis envoyés automatiquement au retour du réseau.
 * Les autres actions (créer un devis, e-mails, photos…) ont besoin d'internet : un message le dit.
 */
(function () {
  'use strict';
  var CFG = window.__STUDIO_HL || {};
  if (!CFG.url || !CFG.key) return;

  // ---------- appels qui lisent (gardés sur l'appareil) et écritures possibles hors connexion ----------
  var LECTURES = ['apiDonnees', 'apiAgenda', 'apiDossiers', 'apiDossier', 'apiTableau', 'apiTodo', 'apiClients', 'apiDemandes',
    'apiHistorique', 'apiPartenaires', 'apiPartenaireSynthese', 'apiModeles', 'apiProduit', 'apiDevisReprise', 'apiOrdem',
    'apiNbWix', 'apiNbTodo', 'apiLienDevis', 'apiVignette', 'apiDetailsDossiers'];
  var ECRITURES_HL = ['apiPaiement', 'apiFrais', 'apiFraisLot', 'apiAgendaSauver', 'apiAgendaSupprimer',
    'apiTodoSauver', 'apiTodoSupprimer', 'apiTodoPayer'];
  var PAR_DEFAUT = { apiVignette: '', apiNbWix: 0, apiNbTodo: { n: 0, urgentes: 0 }, apiLienDevis: '' };
  var MSG_INTERNET = 'Hors connexion : cette action a besoin d’internet. Elle sera possible au retour du réseau.';

  // ---------- mémoire de l'appareil (IndexedDB) ----------
  var dbP = null;
  function db() {
    if (!dbP) dbP = new Promise(function (res, rej) {
      var r = indexedDB.open('studioDevisHorsLigne', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbP;
  }
  function lire(k, def) {
    return db().then(function (d) {
      return new Promise(function (res) {
        var q = d.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = function () { res(q.result === undefined ? def : q.result); };
        q.onerror = function () { res(def); };
      });
    }).catch(function () { return def; });
  }
  function ecrire(k, v) {
    return db().then(function (d) {
      return new Promise(function (res) {
        var t = d.transaction('kv', 'readwrite');
        t.objectStore('kv').put(v, k);
        t.oncomplete = res; t.onerror = res; t.onabort = res;
      });
    }).catch(function () {});
  }
  function cles(prefixe) {
    return db().then(function (d) {
      return new Promise(function (res) {
        var l = [], q = d.transaction('kv').objectStore('kv').openCursor();
        q.onsuccess = function () {
          var c = q.result;
          if (!c) return res(l);
          if (String(c.key).indexOf(prefixe) === 0) l.push(c.key);
          c.continue();
        };
        q.onerror = function () { res(l); };
      });
    }).catch(function () { return []; });
  }
  // une seule opération à la fois sur la file d'attente
  var verrou = Promise.resolve();
  function avecVerrou(f) { var p = verrou.then(f, f); verrou = p.catch(function () {}); return p; }

  // ---------- état et bandeau ----------
  var etat = { horsLigne: !navigator.onLine, envoi: 0 };
  var r2 = function (n) { return Math.round((+n || 0) * 100) / 100; };
  function isoL(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  var tmpId = function () { return 'hl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
  var cleCache = function (fn, args) { return 'c:' + fn + '|' + JSON.stringify(args.slice(1)); };

  // ---------- appel au serveur Studio Devis ----------
  function serveur(fn, args, delai) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = delai && ctl ? setTimeout(function () { ctl.abort(); }, delai) : null;
    var reseau = function () { var x = new Error('Connexion impossible'); x.reseau = true; return x; };
    return fetch(CFG.url, {
      method: 'POST', redirect: 'follow', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: CFG.key, studio: 'api', fn: fn, args: args })
    }).catch(function () { throw reseau(); }).then(function (rep) {
      if (t) clearTimeout(t);
      return rep.json().catch(function () { throw reseau(); });
    }, function (e) { if (t) clearTimeout(t); throw e; }).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && (j.err || j.erreur)) || 'Erreur Studio Devis');
      return j.r;
    });
  }

  function passerHorsLigne() { if (!etat.horsLigne) { etat.horsLigne = true; majBandeau(); } }

  function appeler(fn, args) {
    var lecture = LECTURES.indexOf(fn) >= 0, k = cleCache(fn, args);
    var horsLigne = function () {
      if (fn === 'apiDerniereAction') return null;   // jamais l'action d'avant (elle annulerait une modification du serveur)
      if (lecture) return lire(k).then(function (r) {
        if (r !== undefined) return r;
        if (fn in PAR_DEFAUT) return PAR_DEFAUT[fn];
        throw new Error('Hors connexion : cet écran n’a pas encore été ouvert avec internet sur cet appareil.');
      });
      if (ECRITURES_HL.indexOf(fn) >= 0) return enregistrerHorsLigne(fn, args);
      throw new Error(MSG_INTERNET);
    };
    if (!navigator.onLine || etat.horsLigne) { if (!navigator.onLine) passerHorsLigne(); return Promise.resolve().then(horsLigne); }
    return lire('file', []).then(function (q) { return q.length ? synchroniser() : null; }).then(function () {
      if (etat.horsLigne) return horsLigne();
      return serveur(fn, args, lecture ? 25000 : 0).then(function (r) {
        if (lecture) { ecrire(k, r); ecrire('derniereSynchro', Date.now()); apresLecture(fn, args, r); }
        return r;
      }, function (e) {
        if (!e.reseau) throw e;
        passerHorsLigne();
        if (lecture || fn === 'apiDerniereAction') return horsLigne();
        // la connexion a coupé pendant l'envoi : on ne sait pas si c'est passé, on ne le garde pas en double
        throw new Error('La connexion a coupé pendant l’envoi. Vérifiez si la modification est bien enregistrée avant de recommencer (hors connexion, elle sera gardée sur l’appareil).');
      });
    });
  }

  // ---------- écritures hors connexion : gardées sur l'appareil et appliquées à la copie locale ----------
  function interditSiLocal(id) {
    if (id && /^hl-/.test(String(id))) throw new Error('Cet élément a été créé hors connexion : il pourra être modifié après l’envoi, au retour du réseau.');
  }
  function majCaches(prefixe, f) {
    return cles('c:' + prefixe + '|').then(function (l) {
      return Promise.all(l.map(function (k) {
        return lire(k).then(function (v) {
          if (!v) return;
          var a = JSON.parse(k.slice(k.indexOf('|') + 1));
          if (f(v, a) !== false) return ecrire(k, v);
        });
      }));
    });
  }
  function recalc(d) {
    d.reste = r2(Math.max(0, d.total - d.encaisse));
    d.pourboire = r2(Math.max(0, d.encaisse - d.total));
    d.marge = r2(Math.max(d.total, d.encaisse) - d.frais);
  }
  function ajouterDetail(num, quoi, ligne) {
    var k = 'c:apiDossier|' + JSON.stringify([num]);
    return lire(k, null).then(function (v) {
      v = v || { paiements: [], frais: [] };
      (v[quoi] = v[quoi] || []).push(ligne);
      return ecrire(k, v);
    });
  }
  function tauxConnu() {
    return lire('c:apiDossiers|[]', null).then(function (v) { return (v && v.taux) || 6; });
  }
  function fraisLocal(f, taux) {
    var m = +f.montant || 0, tx = +f.taux || taux, brl = f.devise === 'R$';
    var eur = brl ? r2(m / tx) : m, rs = brl ? m : r2(m * tx);
    var ligne = { 'ID': tmpId(), 'Devis': f.devis, 'Date': f.date || isoL(new Date()), 'Catégorie': f.categorie || 'Divers',
      'Libellé': f.libelle || '', 'Montant': m, 'Devise': brl ? 'R$' : '€', 'Taux R$': tx, 'Montant €': eur, 'Montant R$': rs,
      'Payé à': f.paye || '', 'Note': f.note || '', 'Créé le': isoL(new Date()) };
    return ajouterDetail(f.devis, 'frais', ligne).then(function () {
      return majCaches('apiDossiers', function (v) {
        var d = (v.dossiers || []).find(function (x) { return x.numero === f.devis; });
        if (!d) return false;
        d.frais = r2(d.frais + eur); d.fraisBRL = r2(d.fraisBRL + rs); recalc(d);
      });
    });
  }

  function enregistrerHorsLigne(fn, args) {
    var x = args[1];
    return avecVerrou(function () {
      var travail;
      if (fn === 'apiTodoSauver' || fn === 'apiTodoSupprimer' || fn === 'apiTodoPayer') {
        interditSiLocal(fn === 'apiTodoSupprimer' ? x : x && x.id);
        travail = lire('c:apiTodo|[]', null).then(function (d) {
          if (!d) throw new Error('Hors connexion : ouvrez le To Do une fois avec internet sur cet appareil.');
          var auj = isoL(new Date());
          var trouve = function (id) { return d.taches.find(function (t) { return t.id === id; }); };
          if (fn === 'apiTodoSauver') {
            var t = x.id ? trouve(x.id) : null;
            if (t) {
              t.statut = x.statut || t.statut; t.rappel = x.rappel || '';
              if (x.note != null) t.note = x.note;
              t.fait = t.statut === 'Fait' ? (t.fait || auj) : '';
              if (!t.auto) ['tache', 'detail', 'devis', 'client', 'date'].forEach(function (c) { if (x[c] !== undefined) t[c] = x[c]; });
            } else if (!x.id) {
              d.taches.push({ id: tmpId(), auto: false, sorte: 'libre', devis: x.devis || '', client: x.client || '', date: x.date || '',
                tache: x.tache || '', detail: x.detail || '', statut: x.statut || 'À faire', rappel: x.rappel || '', note: x.note || '',
                fait: x.statut === 'Fait' ? auj : '', paiement: '' });
            }
          } else if (fn === 'apiTodoSupprimer') {
            var i = d.taches.findIndex(function (t) { return t.id === x; });
            if (i >= 0) { if (d.taches[i].auto) d.taches[i].statut = 'Sans objet'; else d.taches.splice(i, 1); }
          } else {
            var tp = trouve(x.id);
            if (tp) {
              var txt = String(x.montant).replace('.', ',') + ' ' + (x.devise || 'R$') + (x.moyen ? ' · ' + x.moyen : '') + (x.paye ? ' · ' + x.paye : '');
              tp.paiement = tp.paiement ? tp.paiement + ' ; ' + txt : txt;
              if (x.fait !== false) { tp.statut = 'Fait'; tp.rappel = ''; tp.fait = tp.fait || auj; }
            }
          }
          return ecrire('c:apiTodo|[]', d).then(function () { return d; });
        });
      } else if (fn === 'apiAgendaSauver') {
        interditSiLocal(x && x.id);
        var nouv = [];
        if (!x.id) {
          var crs = (x.creneaux && x.creneaux.length ? x.creneaux : [x.creneau]).filter(Boolean);
          var d1 = new Date((x.jusquau || x.date) + 'T12:00:00');
          for (var d = new Date(x.date + 'T12:00:00'); d <= d1; d.setDate(d.getDate() + 1)) {
            crs.forEach(function (c) {
              nouv.push({ id: tmpId(), date: isoL(d), creneau: c, statut: x.statut, devis: x.devis || '', client: x.client || '',
                libelle: x.libelle || '', montant: x.montant || '', guide: x.guide || '', commission: x.commission || '', note: x.note || '' });
            });
          }
        }
        travail = majCaches('apiAgenda', function (v, a) {
          if (x.id) {
            var e = (v.entrees || []).find(function (y) { return y.id === x.id; });
            if (!e) return false;
            Object.assign(e, { date: x.date || e.date, creneau: (x.creneaux && x.creneaux[0]) || x.creneau || e.creneau, statut: x.statut || e.statut,
              devis: x.devis || '', client: x.client || '', libelle: x.libelle || '', montant: x.montant || '', guide: x.guide || '',
              commission: x.commission || '', note: x.note || '' });
            return;
          }
          var l = nouv.filter(function (e) { return e.date >= a[0] && e.date <= a[1]; });
          if (!l.length) return false;
          l.forEach(function (e) { v.entrees.push(Object.assign({}, e)); });
        }).then(function () { return x.id ? x.id : nouv.length; });
      } else if (fn === 'apiAgendaSupprimer') {
        interditSiLocal(x);
        travail = majCaches('apiAgenda', function (v) {
          var i = (v.entrees || []).findIndex(function (e) { return e.id === x; });
          if (i < 0) return false;
          v.entrees.splice(i, 1);
        }).then(function () { return true; });
      } else if (fn === 'apiPaiement') {
        travail = tauxConnu().then(function (taux) {
          var eur = +x.montant || 0, tx = +x.taux || taux, brl = +x.montantBRL || r2(eur * tx);
          var ligne = { 'ID': tmpId(), 'Devis': x.devis, 'Date': x.date || isoL(new Date()), 'Type': x.type || 'Autre', 'Montant €': eur,
            'Moyen': x.moyen || '', 'Taux R$': tx, 'Montant R$': brl, 'Note': x.note || '', 'Créé le': isoL(new Date()) };
          return ajouterDetail(x.devis, 'paiements', ligne).then(function () {
            return majCaches('apiDossiers', function (v) {
              var d = (v.dossiers || []).find(function (y) { return y.numero === x.devis; });
              if (!d) return false;
              d.encaisse = r2(d.encaisse + eur); d.encaisseBRL = r2(d.encaisseBRL + brl); recalc(d);
              if (['Attente confirmation', 'Attente acompte', 'Réservé'].indexOf(d.statut) >= 0) d.statut = d.reste <= 0.5 ? 'Soldé' : 'Réservé';
            });
          }).then(function () { return true; });
        });
      } else if (fn === 'apiFrais') {
        travail = tauxConnu().then(function (taux) { return fraisLocal(x, taux); }).then(function () { return true; });
      } else if (fn === 'apiFraisLot') {
        var l = (x || []).filter(function (f) { return f.devis && +f.montant; });
        if (!l.length) throw new Error('Aucune ligne complète (dossier et montant).');
        travail = tauxConnu().then(function (taux) {
          return l.reduce(function (p, f) { return p.then(function () { return fraisLocal(f, taux); }); }, Promise.resolve());
        }).then(function () { return l.length; });
      }
      return travail.then(function (res) {
        return lire('file', []).then(function (q) {
          q.push({ id: tmpId(), fn: fn, args: args, t: Date.now() });
          return ecrire('file', q);
        }).then(function () { majBandeau(); return res; });
      });
    });
  }

  // ---------- envoi de la file d'attente au retour du réseau ----------
  var syncEnCours = null;
  function synchroniser() {
    if (syncEnCours) return syncEnCours;
    syncEnCours = avecVerrou(function () {
      var envoyes = 0;
      var suivant = function () {
        return lire('file', []).then(function (q) {
          if (!q.length) return;
          etat.envoi = q.length; majBandeau();
          var op = q[0];
          return serveur(op.fn, op.args, 0).then(function () { envoyes++; }, function (e) {
            if (e.reseau) { etat.horsLigne = true; throw e; }
            return lire('echecs', []).then(function (ech) {
              ech.push({ fn: op.fn, args: op.args, t: op.t, erreur: e.message });
              return ecrire('echecs', ech);
            });
          }).then(function () {
            return lire('file', []).then(function (q2) { q2.shift(); return ecrire('file', q2); });
          }).then(suivant);
        });
      };
      return suivant().then(function () {
        etat.horsLigne = false;
      }, function () {}).then(function () {
        etat.envoi = 0; majBandeau();
        if (envoyes) rafraichir();
      });
    });
    syncEnCours.then(function () { syncEnCours = null; }, function () { syncEnCours = null; });
    return syncEnCours;
  }
  function rafraichir() {
    try {
      var todo = document.getElementById('v-todo');
      if (todo && !todo.classList.contains('cache') && typeof window.ouvrirTodo === 'function') window.ouvrirTodo();
      else if (typeof window.rafraichirVue === 'function') window.rafraichirVue();
      if (typeof window.verifierTodo === 'function') window.verifierTodo();
    } catch (e) {}
  }
  // retour du réseau : on vérifie avec un petit appel, puis on envoie
  function essayerRetour() {
    if (!navigator.onLine) return;
    lire('file', []).then(function (q) {
      if (!etat.horsLigne && !q.length) return;
      return serveur('apiDerniereAction', [CFG.key], 10000).then(function () {
        etat.horsLigne = false; majBandeau();
        return synchroniser();
      }, function () { etat.horsLigne = true; majBandeau(); });
    });
  }
  window.addEventListener('online', essayerRetour);
  window.addEventListener('offline', function () { passerHorsLigne(); });
  setInterval(essayerRetour, 20000);

  // ---------- copies d'avance : ce qui sera utile hors connexion ----------
  var deja = {};
  function uneFois(nom, ms) { var t = Date.now(); if (deja[nom] && t - deja[nom] < ms) return false; deja[nom] = t; return true; }
  function bornesMois(an, mois) {
    var d0 = new Date(an, mois, 1, 12); d0.setDate(d0.getDate() - ((d0.getDay() + 6) % 7));
    var d1 = new Date(d0); d1.setDate(d1.getDate() + 41);
    return [isoL(d0), isoL(d1)];
  }
  function copier(fn, args) {
    return serveur(fn, [CFG.key].concat(args), 30000).then(function (r) { return ecrire(cleCache(fn, [CFG.key].concat(args)), r); }, function () {});
  }
  function apresLecture(fn, args) {
    if (fn === 'apiDossiers' && uneFois('details', 10 * 60000)) {
      serveur('apiDetailsDossiers', [CFG.key], 60000).then(function (tout) {
        return Promise.all(Object.keys(tout || {}).map(function (num) { return ecrire('c:apiDossier|' + JSON.stringify([num]), tout[num]); }));
      }, function () {});
    }
    if (fn === 'apiAgenda' && args[1] && args[2] && uneFois('agenda' + args[1], 60 * 60000)) {
      var m = new Date(args[1] + 'T12:00:00'); m.setDate(m.getDate() + 7);   // mois affiché
      [-1, 1, 2, 3].reduce(function (p, k) {
        return p.then(function () { var b = bornesMois(m.getFullYear(), m.getMonth() + k); return copier('apiAgenda', b); });
      }, Promise.resolve());
    }
    if (uneFois('depart', 30 * 60000)) {
      setTimeout(function () {
        ['apiTodo', 'apiDossiers', 'apiClients', 'apiTableau', 'apiPartenaires'].reduce(function (p, f) {
          return p.then(function () { return copier(f, []); });
        }, Promise.resolve()).then(function () {
          return serveur('apiDetailsDossiers', [CFG.key], 60000).then(function (tout) {
            deja.details = Date.now();
            return Promise.all(Object.keys(tout || {}).map(function (num) { return ecrire('c:apiDossier|' + JSON.stringify([num]), tout[num]); }));
          }, function () {});
        });
      }, 4000);
    }
  }

  // ---------- google.script.run de remplacement ----------
  function Runner(ok, ko, u) {
    return new Proxy({}, {
      get: function (_, k) {
        if (k === 'withSuccessHandler') return function (f) { return Runner(f, ko, u); };
        if (k === 'withFailureHandler') return function (f) { return Runner(ok, f, u); };
        if (k === 'withUserObject') return function (o) { return Runner(ok, ko, o); };
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          Promise.resolve().then(function () { return appeler(k, args); }).then(function (r) {
            if (ok) ok(r, u);
          }, function (e) {
            if (ko) ko(e instanceof Error ? e : new Error(String(e)), u);
            else if (window.console) console.warn('Studio Devis ·', k, e);
          });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { run: Runner(null, null, undefined), host: { close: function () {}, setHeight: function () {} } };

  // ---------- bandeau d'état (en haut à droite ; sous la barre du haut sur iPhone) ----------
  var CSS = '#hlBandeau{position:fixed;z-index:500;top:12px;right:16px;max-width:calc(100vw - 32px);box-sizing:border-box;display:none;align-items:center;gap:8px;'
    + 'padding:8px 14px;border-radius:999px;font:600 12.5px Poppins,system-ui,sans-serif;background:#1F2330;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);cursor:default}'
    + '#hlBandeau.vu{display:flex}#hlBandeau.att{background:#B45611}#hlBandeau.err{background:#B4281A;cursor:pointer}#hlBandeau small{font-weight:400;opacity:.8}'
    + '@media(max-width:700px){#hlBandeau{top:calc(66px + env(safe-area-inset-top,0px));right:50%;transform:translateX(50%)}}'
    + '#hlEchecs{position:fixed;inset:0;z-index:600;background:rgba(10,13,22,.6);display:flex;align-items:center;justify-content:center;padding:16px}'
    + '#hlEchecs .b{background:#fff;color:#1F2330;border-radius:20px;max-width:520px;width:100%;max-height:80vh;overflow:auto;padding:20px;font:14px/1.5 Poppins,system-ui,sans-serif}'
    + '#hlEchecs h3{margin:0 0 8px}#hlEchecs li{margin:6px 0}#hlEchecs button{border:0;border-radius:10px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;margin-left:6px}';
  var NOMS = { apiPaiement: 'Encaissement', apiFrais: 'Frais', apiFraisLot: 'Frais du jour', apiAgendaSauver: 'Agenda', apiAgendaSupprimer: 'Créneau supprimé',
    apiTodoSauver: 'Tâche', apiTodoSupprimer: 'Tâche retirée', apiTodoPayer: 'Paiement d’une tâche' };
  function bandeau() {
    var b = document.getElementById('hlBandeau');
    if (b || !document.body) return b;
    var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
    b = document.createElement('div'); b.id = 'hlBandeau'; b.setAttribute('role', 'status');
    b.onclick = function () { if (b.classList.contains('err')) voirEchecs(); };
    document.body.appendChild(b);
    return b;
  }
  function majBandeau() {
    Promise.all([lire('file', []), lire('echecs', []), lire('derniereSynchro', 0)]).then(function (r) {
      var b = bandeau(); if (!b) return;
      var n = r[0].length, ech = r[1].length, ds = r[2];
      var pl = function (k, mot) { return k + ' ' + mot + (k > 1 ? 's' : ''); };
      var quand = ds ? new Date(ds).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      b.className = '';
      if (ech) { b.className = 'vu err'; b.innerHTML = '⚠ ' + pl(ech, 'modification') + ' refusée' + (ech > 1 ? 's' : '') + ' <small>· voir</small>'; return; }
      if (etat.horsLigne) {
        b.className = 'vu' + (n ? ' att' : '');
        b.innerHTML = '📴 Hors connexion' + (n ? ' · ' + pl(n, 'modification') + ' à envoyer' : '') + (quand ? ' <small>· données du ' + quand + '</small>' : '');
        return;
      }
      if (etat.envoi) { b.className = 'vu att'; b.textContent = '↻ Envoi de ' + pl(etat.envoi, 'modification') + '…'; return; }
      if (n) { b.className = 'vu att'; b.textContent = '⏳ ' + pl(n, 'modification') + ' en attente d’envoi'; }
    });
  }
  function voirEchecs() {
    lire('echecs', []).then(function (l) {
      var o = document.createElement('div'); o.id = 'hlEchecs';
      var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
      o.innerHTML = '<div class="b"><h3>Modifications refusées par Studio Devis</h3><p>Elles avaient été faites hors connexion. Refaites-les si besoin, puis retirez cette liste.</p><ul>'
        + l.map(function (e) {
          var a = e.args && e.args[1], det = a && typeof a === 'object' ? [a.devis, a.date, a.libelle || a.tache || a.type, a.montant].filter(Boolean).join(' · ') : String(a || '');
          return '<li><b>' + esc(NOMS[e.fn] || e.fn) + '</b> ' + esc(det) + '<br><small>' + esc(e.erreur) + '</small></li>';
        }).join('') + '</ul><div style="text-align:right"><button id="hlFermer" style="background:#F1EFEC">Fermer</button><button id="hlVider" style="background:#EE8938;color:#fff">Retirer la liste</button></div></div>';
      document.body.appendChild(o);
      o.querySelector('#hlFermer').onclick = function () { o.remove(); };
      o.querySelector('#hlVider').onclick = function () { ecrire('echecs', []).then(function () { o.remove(); majBandeau(); }); };
    });
  }
  document.addEventListener('DOMContentLoaded', function () { majBandeau(); essayerRetour(); });

  window.StudioHorsLigne = { etat: etat, synchroniser: synchroniser, lire: lire };
})();
