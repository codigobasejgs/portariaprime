import React, { useState } from 'react';
import { ArrowLeft, Mail, KeyRound, AlertCircle, LogIn, UserPlus } from 'lucide-react';
import { Unit } from '../../types';
import { VillageAzaleiaLogo } from '../VillageAzaleiaLogo';
import { MoradorRegistrationModal } from '../MoradorRegistrationModal';
import { loginMorador } from '../../services/auth.service';
import { sound } from '../../utils/audio';

interface MoradorAuthScreenProps {
  onBack: () => void;
  onSaveUnit: (unit: Unit, skipDbSync?: boolean) => void;
  onAuthSuccess: (nome: string) => void;
  onShowToast: (message: string, type?: 'success' | 'info' | 'warning') => void;
}

export const MoradorAuthScreen: React.FC<MoradorAuthScreenProps> = ({
  onBack,
  onSaveUnit,
  onAuthSuccess,
  onShowToast
}) => {
  const [activeTab, setActiveTab] = useState<'entrar' | 'cadastrar'>('entrar');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await loginMorador(email, password);
      if (!res.ok || !res.profile) {
        sound.playError();
        setError(res.error || 'E-mail ou senha incorretos. Ainda não tem conta? Use a aba Cadastrar.');
        return;
      }
      sound.playSuccess();
      onAuthSuccess(res.profile.name);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegisterSave = (unit: Unit, skipDbSync?: boolean) => {
    onSaveUnit(unit, skipDbSync);
    onAuthSuccess(unit.residentName);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#061D12] via-[#0D3823] to-[#15462D] px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[#FFF2B2] text-xs font-bold hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Voltar</span>
        </button>

        <div className="bg-white rounded-3xl border-2 border-[#D4AF37] shadow-2xl overflow-hidden">
          <div className="bg-gradient-to-r from-[#061D12] via-[#0D3823] to-[#15462D] p-6 flex flex-col items-center text-center gap-1.5">
            <VillageAzaleiaLogo size="sm" />
            <h2 className="text-base font-black text-white">Espaço do Morador</h2>
            <p className="text-[11px] text-white/70 font-medium">Acompanhe suas encomendas em tempo real</p>
          </div>

          <div className="flex border-b border-slate-200">
            <button
              type="button"
              onClick={() => {
                setActiveTab('entrar');
                setError(null);
              }}
              className={`flex-1 py-3 text-xs font-black flex items-center justify-center gap-1.5 transition-colors ${
                activeTab === 'entrar'
                  ? 'text-[#0D3823] border-b-2 border-[#0D3823] bg-[#E8F5E9]/40'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Entrar</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('cadastrar');
                setError(null);
              }}
              className={`flex-1 py-3 text-xs font-black flex items-center justify-center gap-1.5 transition-colors ${
                activeTab === 'cadastrar'
                  ? 'text-[#D81B60] border-b-2 border-[#D81B60] bg-[#FCE4EC]/40'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Cadastrar</span>
            </button>
          </div>

          {activeTab === 'entrar' ? (
            <form onSubmit={handleLogin} className="p-6 space-y-4">
              {error && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">E-mail cadastrado:</label>
                <div className="relative">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="seu.email@exemplo.com"
                    required
                    autoComplete="username"
                    className="w-full bg-[#F8F9FA] border border-slate-300 rounded-xl pl-9 pr-3 py-2.5 text-xs font-bold text-[#0D3823] focus:border-[#0D3823] focus:ring-2 focus:ring-[#0D3823]/20"
                  />
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">Senha:</label>
                <div className="relative">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full bg-[#F8F9FA] border border-slate-300 rounded-xl pl-9 pr-3 py-2.5 text-xs font-bold text-[#0D3823] focus:border-[#0D3823] focus:ring-2 focus:ring-[#0D3823]/20"
                  />
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-[#0D3823] via-[#15462D] to-[#0D3823] hover:from-[#15462D] hover:to-[#061D12] text-[#FFF2B2] font-black text-xs shadow-lg border border-[#D4AF37] transition-all active:scale-95 disabled:opacity-50"
              >
                {isSubmitting ? 'Entrando...' : 'Entrar no App'}
              </button>
            </form>
          ) : (
            <div className="p-6 text-center space-y-4">
              <p className="text-xs text-slate-600 leading-relaxed">
                Cadastre sua unidade para receber avisos imediatos de encomendas via WhatsApp e E-mail.
              </p>
              <MoradorRegistrationModal
                isOpen
                mode="register"
                onClose={() => setActiveTab('entrar')}
                onSaveUnit={handleRegisterSave}
                onShowToast={onShowToast}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
