"use client";
import { useFormStatus } from "react-dom";
import { BTN } from "./ui";

export function SubmitButton({
  children,
  variant = "primario",
  className = "",
  confirm,
  name,
  value,
  formAction,
  disabled = false,
}: {
  children: React.ReactNode;
  variant?: keyof typeof BTN;
  className?: string;
  confirm?: string;
  name?: string;
  value?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  /** Bloqueia o envio quando o formulario ainda tem erro conhecido. */
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      formAction={formAction}
      disabled={pending || disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={`${BTN[variant]} ${className}`}
    >
      {pending ? "Aguarde…" : children}
    </button>
  );
}
